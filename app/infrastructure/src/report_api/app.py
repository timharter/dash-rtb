import os
import json
import logging
import boto3
from typing import Dict, Any
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda function to handle report submissions via REST API.
    Publishes the report data to all connected WebSocket clients.
    """
    try:
        # Parse the incoming report from the request body
        if 'body' not in event:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Request body is required'})
            }
        
        # Handle both string and dict body formats
        if isinstance(event['body'], str):
            try:
                report_data = json.loads(event['body'])
            except json.JSONDecodeError:
                return {
                    'statusCode': 400,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({'error': 'Invalid JSON in request body'})
                }
        else:
            report_data = event['body']
        
        logger.info(f"Received report: {json.dumps(report_data)}")
        
        # Get environment variables
        websocket_api_id = os.environ.get('WEBSOCKET_API_ID')
        stage = os.environ.get('WEBSOCKET_STAGE', 'Prod')
        region = os.environ.get('AWS_REGION')
        connection_table = os.environ.get('CONNECTION_TABLE_NAME')
        
        if not all([websocket_api_id, region, connection_table]):
            logger.error("Missing required environment variables")
            return {
                'statusCode': 500,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Server configuration error'})
            }
        
        # Create WebSocket API endpoint URL
        websocket_endpoint = f"https://{websocket_api_id}.execute-api.{region}.amazonaws.com/{stage}"
        
        # Get all active WebSocket connections from DynamoDB
        dynamodb = boto3.client('dynamodb')
        try:
            response = dynamodb.scan(
                TableName=connection_table,
                ProjectionExpression='connectionId'
            )
            connections = response.get('Items', [])
        except ClientError as e:
            logger.error(f"Error scanning connection table: {str(e)}")
            return {
                'statusCode': 500,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Failed to retrieve connections'})
            }
        
        if not connections:
            logger.info("No active WebSocket connections found")
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'message': 'Report received successfully',
                    'connections_notified': 0
                })
            }
        
        # Create API Gateway Management API client for WebSocket
        api_client = boto3.client(
            'apigatewaymanagementapi',
            endpoint_url=websocket_endpoint
        )
        
        # Prepare the message to send to WebSocket clients
        websocket_message = {
            'messageType': 'report',
            'data': report_data,
            'timestamp': context.aws_request_id if context else None
        }
        
        # Send the report to all connected WebSocket clients
        successful_sends = 0
        failed_connections = []
        
        for connection in connections:
            connection_id = connection['connectionId']['S']
            try:
                api_client.post_to_connection(
                    ConnectionId=connection_id,
                    Data=json.dumps(websocket_message)
                )
                successful_sends += 1
                logger.info(f"Successfully sent report to connection: {connection_id}")
                
            except ClientError as e:
                error_code = e.response['Error']['Code']
                if error_code in ['GoneException', 'ResourceNotFoundException']:
                    # Connection is stale, mark for cleanup
                    failed_connections.append(connection_id)
                    logger.info(f"Stale connection found: {connection_id}")
                else:
                    logger.error(f"Error sending to connection {connection_id}: {str(e)}")
        
        # Clean up stale connections
        for failed_connection_id in failed_connections:
            try:
                dynamodb.delete_item(
                    TableName=connection_table,
                    Key={'connectionId': {'S': failed_connection_id}}
                )
                logger.info(f"Cleaned up stale connection: {failed_connection_id}")
            except ClientError as e:
                logger.error(f"Error cleaning up connection {failed_connection_id}: {str(e)}")
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Report received and published successfully',
                'connections_notified': successful_sends,
                'stale_connections_cleaned': len(failed_connections)
            })
        }
        
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }