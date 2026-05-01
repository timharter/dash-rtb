#!/bin/bash

# Test script for the UnicornDash Report API
# Usage: ./test_report_api.sh <api_endpoint> <api_key>

set -e

# Check if correct number of arguments provided
if [ $# -ne 2 ]; then
    echo "Usage: $0 <api_endpoint> <api_key>"
    echo "Example: $0 https://abc123.execute-api.us-east-1.amazonaws.com/Prod/report your-api-key"
    exit 1
fi

API_ENDPOINT="$1"
API_KEY="$2"

# Generate current timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create sample report JSON
REPORT_DATA=$(cat <<EOF
{
  "reportId": "RPT-001",
  "timestamp": "$TIMESTAMP",
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
EOF
)

echo "🚀 Testing UnicornDash Report API"
echo "=================================="
echo "Endpoint: $API_ENDPOINT"
echo "Timestamp: $TIMESTAMP"
echo ""
echo "📋 Report Data:"
echo "$REPORT_DATA" | jq '.' 2>/dev/null || echo "$REPORT_DATA"
echo ""
echo "📤 Sending request..."

# Make the API request and capture response
TEMP_FILE=$(mktemp)
HTTP_STATUS=$(curl -s -w "%{http_code}" \
  -X POST "$API_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "$REPORT_DATA" \
  -o "$TEMP_FILE")

# Read response body from temp file
RESPONSE_BODY=$(cat "$TEMP_FILE")
rm -f "$TEMP_FILE"

# Get response time (simplified)
RESPONSE_TIME="N/A"

echo "📥 Response:"
echo "Status Code: $HTTP_STATUS"
echo "Response Time: ${RESPONSE_TIME}s"
echo "Response Body:"
echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
echo ""

# Check if request was successful
if [ "$HTTP_STATUS" -eq 200 ]; then
    echo "✅ Report submitted successfully!"
    
    # Try to extract connection count from response
    CONNECTIONS=$(echo "$RESPONSE_BODY" | jq -r '.connections_notified // "unknown"' 2>/dev/null)
    if [ "$CONNECTIONS" != "unknown" ] && [ "$CONNECTIONS" != "null" ]; then
        echo "📡 Notified $CONNECTIONS WebSocket connections"
    fi
else
    echo "❌ Failed to submit report (HTTP $HTTP_STATUS)"
    exit 1
fi