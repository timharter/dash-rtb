# UnicornDash Report API

This document describes the new REST API Gateway that allows external systems to submit reports in JSON format. When a report is submitted, it's automatically published to all connected WebSocket clients in real-time.

## Overview

The Report API consists of:
- **REST API Gateway** with API key authentication
- **Lambda function** that processes reports and publishes to WebSocket
- **API key management** with usage plans and throttling

## API Endpoint

After deployment, the API will be available at:
```
https://{api-id}.execute-api.{region}.amazonaws.com/Prod/report
```

## Authentication

The API uses API key authentication. Include the API key in the request header:
```
X-API-Key: your-api-key-here
```

## Usage

### Submit a Report

**Endpoint:** `POST /report`

**Headers:**
```
Content-Type: application/json
X-API-Key: your-api-key-here
```

**Request Body:**
```json
{
  "reportId": "RPT-001",
  "timestamp": "2024-01-15T10:30:00Z",
  "type": "performance",
  "data": {
    "cpu_usage": 75.2,
    "memory_usage": 68.5,
    "disk_usage": 45.1,
    "network_latency": 12.3
  },
  "source": "monitoring-system",
  "severity": "medium",
  "message": "System performance metrics report"
}
```

**Response:**
```json
{
  "message": "Report received and published successfully",
  "connections_notified": 3,
  "stale_connections_cleaned": 0
}
```

### WebSocket Message Format

When a report is submitted, connected WebSocket clients receive:
```json
{
  "messageType": "report",
  "data": {
    // Original report data
  },
  "timestamp": "request-id-from-lambda"
}
```

## Rate Limiting

The API includes the following limits:
- **Rate Limit:** 100 requests per second
- **Burst Limit:** 200 requests
- **Daily Quota:** 10,000 requests per day

## Testing

Use the provided test script:
```bash
python test_report_api.py <api_endpoint> <api_key>
```

Example:
```bash
python test_report_api.py https://abc123.execute-api.us-east-1.amazonaws.com/Prod/report your-api-key-here
```

## Deployment

Deploy using SAM CLI:
```bash
sam build
sam deploy
```

After deployment, retrieve the API endpoint and key from the CloudFormation outputs:
- `ReportApiEndpoint`: The API endpoint URL
- `ReportApiKey`: The API key for authentication

## Error Handling

The API returns appropriate HTTP status codes:
- **200**: Success
- **400**: Bad request (invalid JSON, missing body)
- **401**: Unauthorized (invalid or missing API key)
- **500**: Internal server error

## Security Features

- API key authentication prevents unauthorized access
- CORS enabled for cross-origin requests
- Rate limiting and quotas prevent abuse
- Automatic cleanup of stale WebSocket connections

## Architecture

```
External System → REST API Gateway → Lambda Function → WebSocket API → Connected Clients
                      ↓
                  API Key Auth
                      ↓
                 Usage Plan/Throttling
```

The Lambda function:
1. Validates the incoming JSON report
2. Retrieves all active WebSocket connections from DynamoDB
3. Publishes the report to all connected clients
4. Cleans up any stale connections
5. Returns success/failure status