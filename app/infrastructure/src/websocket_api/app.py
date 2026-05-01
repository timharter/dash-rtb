import os
import json
import time
import logging
import aioboto3
import boto3
import asyncio
from typing import Dict, Any
from botocore.exceptions import ClientError
from botocore.client import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

class WebSocketFunctions:
    def __init__(self):
        self.session = aioboto3.Session()
        self.TABLE_NAME = os.environ.get('TABLE_NAME')
        
    def _create_api_client(self, endpoint: str):
        # Using standard boto3 (not aioboto3) for API Gateway Management API
        return boto3.client(
            'apigatewaymanagementapi',
            endpoint_url=endpoint,
            config=Config(max_pool_connections=50)
        )
    
    async def on_connect(self, event: Dict[str, Any], context: Any) -> Dict[str, Any]:
        """Handler for WebSocket API Connect route."""
        connection_id = event['requestContext']['connectionId']
        logger.info(f"Connection established: {connection_id}")

        try:
            # Store connectionId in DynamoDB
            async with self.session.client('dynamodb') as ddb_client:
                await ddb_client.put_item(
                    TableName=self.TABLE_NAME,
                    Item={
                        'connectionId': {'S': connection_id},
                        'ttl': {'N': str(int(time.time()) + 3600)}  # TTL of 1 hour
                    }
                )
            
            return {
                'statusCode': 200,
                'body': 'Connected'
            }
            
        except Exception as e:
            logger.error(f"Failed to store connection: {str(e)}")
            return {
                'statusCode': 500,
                'body': 'Failed to connect'
            }

    async def send_message(self, event: Dict[str, Any], context: Any) -> Dict[str, Any]:
        """Handler for WebSocket API SendMessage route."""
        try:
            request_context = event['requestContext']
            connection_id = request_context['connectionId']
            domain_name = request_context['domainName']
            stage = request_context['stage']
            endpoint = f"https://{domain_name}/{stage}"
            
            # Parse message type and username from the request body
            body = json.loads(event['body'])
            message_type = body.get('messageType')
            username = body.get('username', 'Anonymous')
            
            if not message_type or message_type not in ['red', 'blue', 'getstate']:
                logger.error(f"Invalid message type: {message_type}")
                return {
                    'statusCode': 400,
                    'body': 'Valid message type not specified in request body'
                }
                
            # Get current position counts from DynamoDB or initialize
            position_counts = {'red': 0, 'blue': 0}
            
            # Use a separate table or item for position counting
            TRACKING_TABLE = os.environ.get('TRACKING_TABLE', self.TABLE_NAME)
            
            try:
                async with self.session.client('dynamodb') as ddb_client:
                    # Try to get current position counts
                    response = await ddb_client.get_item(
                        TableName=TRACKING_TABLE,
                        Key={'id': {'S': 'position_counts'}}
                    )
                    
                    if 'Item' in response:
                        position_counts = {
                            'red': int(response['Item'].get('red', {'N': '0'})['N']),
                            'blue': int(response['Item'].get('blue', {'N': '0'})['N'])
                        }
            except Exception as e:
                logger.error(f"Error getting position counts: {str(e)}")
            
            # Increment the position
            if message_type != 'getstate':
                position_counts[message_type] += 1
            
            # Update position counts in DynamoDB
            try:
                async with self.session.client('dynamodb') as ddb_client:
                    await ddb_client.put_item(
                        TableName=TRACKING_TABLE,
                        Item={
                            'id': {'S': 'position_counts'},
                            'red': {'N': str(position_counts['red'])},
                            'blue': {'N': str(position_counts['blue'])},
                            'ttl': {'N': str(int(time.time()) + 86400)}  # 24 hour TTL
                        }
                    )
            except Exception as e:
                logger.error(f"Error updating position counts: {str(e)}")

            # Get all connections from DynamoDB
            async with self.session.client('dynamodb') as ddb_client:
                response = await ddb_client.scan(
                    TableName=self.TABLE_NAME,
                    ProjectionExpression='connectionId'
                )
            items = response.get('Items', [])

            # Create API Gateway Management API client
            api_client = self._create_api_client(endpoint)
            
            # Broadcast updated position count to all connected clients
            connection_count = 0
            failed_connections = []
            
            for item in items:
                target_connection_id = item['connectionId']['S']
                try:
                    if message_type in ['red', 'blue']:
                        # Standard boto3 client doesn't use await
                        api_client.post_to_connection(
                            Data=json.dumps({"messageType": message_type, "count": position_counts[message_type], "username": username}),
                            ConnectionId=target_connection_id
                        )
                    elif message_type == 'getstate':
                        # Standard boto3 client doesn't use await
                        api_client.post_to_connection(
                            ConnectionId=connection_id,
                            Data=json.dumps({
                                "messageType": "positionCounts",
                                "red": position_counts['red'], 
                                "blue": position_counts['blue']
                            })
                        )

                    connection_count += 1
                except ClientError as e:
                    if e.response['Error']['Code'] in ['GoneException', 'ResourceNotFoundException']:
                        failed_connections.append(target_connection_id)
                    else:
                        logger.error(f"Error sending message: {str(e)}")
            
            # Clean up stale connections
            for failed_id in failed_connections:
                try:
                    async with self.session.client('dynamodb') as ddb_client:
                        await ddb_client.delete_item(
                            TableName=self.TABLE_NAME,
                            Key={'connectionId': {'S': failed_id}}
                        )
                except Exception as e:
                    logger.error(f"Error removing stale connection {failed_id}: {str(e)}")

            return {
                'statusCode': 200,
                'body': f'Message sent to {connection_count} connections'
            }

        except Exception as e:
            logger.error(f"Failed to process message: {str(e)}")
            return {
                'statusCode': 500,
                'body': 'Failed to process message'
            }

    async def on_disconnect(self, event: Dict[str, Any], context: Any) -> Dict[str, Any]:
        """Handler for WebSocket API Disconnect route."""
        connection_id = event['requestContext']['connectionId']
        logger.info(f"Client disconnected: {connection_id}")

        try:
            # Remove connection ID from the table
            async with self.session.client('dynamodb') as ddb_client:
                await ddb_client.delete_item(
                    TableName=self.TABLE_NAME,
                    Key={'connectionId': {'S': connection_id}}
                )
            
            return {
                'statusCode': 200,
                'body': 'Disconnected'
            }
            
        except Exception as e:
            logger.error(f"Failed to remove connection: {str(e)}")
            return {
                'statusCode': 500,
                'body': 'Failed to disconnect properly'
            }

# Handler functions
functions = WebSocketFunctions()

# Wrapper functions to handle async/await properly
def connect_handler(event, context):
    logger.info(f"Event received: {json.dumps(event)}")
    return asyncio.run(functions.on_connect(event, context))

def disconnect_handler(event, context):
    logger.info(f"Event received: {json.dumps(event)}")
    return asyncio.run(functions.on_disconnect(event, context))

def send_message_handler(event, context):
    logger.info(f"Event received: {json.dumps(event)}")
    return asyncio.run(functions.send_message(event, context))
