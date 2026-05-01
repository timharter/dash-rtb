# Load Generator Lambda

AWS Lambda functions for starting and stopping Kubernetes load generator jobs on EKS clusters via API Gateway.

## Overview

This project provides two Lambda functions:
- **Start Lambda** (`lambda_loadgen_start.py`) - Deploys a Helm chart to start load generation
- **Stop Lambda** (`lambda_loadgen_stop.py`) - Deletes the load generator job

Both functions are exposed via API Gateway with API key authentication.

## Architecture

```
API Gateway → Lambda Functions → EKS Cluster
     ↓              ↓               ↓
   /start    Start Function    Helm Deploy
   /stop     Stop Function     kubectl delete
```

## Prerequisites

- AWS CLI configured
- CDK CLI installed (`npm install -g aws-cdk`)
- Python 3.13+
- EKS cluster with appropriate permissions
- ECR repository for container images

## Deployment

```bash
./deploy_cdk.sh deploy \
  --target-nlb <target-nlb-url> \
  --target-heimdall <target-heimdall-url> \
  --ecr-repo <ecr-repo-name> \
  --cluster <cluster-name> \
  --report-api-url <report-api-url> \
  --report-api-key <report-api-key> \
  --region <region>  # optional, defaults to us-east-1
```

### Deploy Options

- `-n, --target-nlb` - Target URL for NLB environment (required)
- `-h, --target-heimdall` - Target URL for Heimdall environment (required)
- `-e, --ecr-repo` - ECR repository name (required)
- `-c, --cluster` - EKS cluster name (required)
- `-a, --report-api-url` - Report API URL (required)
- `-k, --report-api-key` - Report API key (required)
- `-r, --region` - AWS region (optional, default: us-east-1)

### Example

```bash
./deploy_cdk.sh deploy \
  --target-nlb http://nlb.example.com/bidrequest \
  --target-heimdall http://heimdall.example.com/bidrequest \
  --ecr-repo load-gen \
  --cluster publisher-eks \
  --report-api-url https://api.example.com/report \
  --report-api-key abc123xyz \
  --region us-east-1
```

## API Usage

### Start Load Generator

```bash
curl -X POST https://your-api-gateway-url/start \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{
    "duration": "10m",
    "devicesUsed": "1000",
    "numberOfJobs": "1",
    "ratePerJob": "0",
    "rtbEnv": "production"
  }'
```

### Stop Load Generator

```bash
curl -X POST https://your-api-gateway-url/stop \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{}'
```

## Configuration

### Environment Variables

**Start Lambda:**
- `EKS_CLUSTER_NAME` - EKS cluster name
- `EKS_REGION` - AWS region
- `TARGET_NLB` - Target URL for NLB environment
- `TARGET_HEIMDALL` - Target URL for Heimdall environment
- `ECR_REPOSITORY_NAME` - ECR repository name
- `REPORT_API_URL` - Report API URL
- `REPORT_API_KEY` - Report API key

**Stop Lambda:**
- `EKS_CLUSTER_NAME` - EKS cluster name
- `EKS_REGION` - AWS region

### Event Parameters

**Start Lambda accepts:**
- `cluster_name` - Override cluster name
- `target` - Override target URL (optional - if not provided, uses TARGET_NLB or TARGET_HEIMDALL based on rtbEnv)
- `duration` - Test duration (default: "10m")
- `devicesUsed` - Number of devices to simulate (default: "1000")
- `numberOfJobs` - Number of parallel jobs (default: "1")
- `ratePerJob` - Rate limiting per job (default: "0")
- `rtbEnv` - RTB environment value (required - 'nlb' or 'heimdall')

## Files

- `lambda_loadgen_start.py` - Start Lambda function
- `lambda_loadgen_stop.py` - Stop Lambda function
- `cdk/` - CDK infrastructure code
- `deploy_cdk.sh` - CDK deployment script
- `build_lambda_layer.sh` - Builds kubectl/helm layer
- `requirements.txt` - Python dependencies

## Dependencies

- `boto3` - AWS SDK
- `eks-token` - EKS authentication
- kubectl/helm binaries (via Lambda layer)

## Cleanup

```bash
./deploy_cdk.sh destroy --cluster <cluster-name> --region <region>
```

Or without EKS cleanup:

```bash
./deploy_cdk.sh destroy
```

### Destroy Options

- `-c, --cluster` - EKS cluster name (optional, for IAM access entry cleanup)
- `-r, --region` - AWS region (optional, default: us-east-1)

## Troubleshooting

- Ensure Lambda execution role has EKS permissions
- Verify EKS cluster is accessible from Lambda
- Check API Gateway API key configuration
- Review CloudWatch logs for detailed error messages
