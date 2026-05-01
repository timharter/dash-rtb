#!/bin/bash

# CDK deployment script for the Helm Lambda function
# Usage: ./deploy_cdk.sh <target-url> <ecr-repository-name> [cluster-name] [region]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

configure_eks_auth() {
    local role_name="$1"
    
    if [[ -n "$CLUSTER_NAME" ]]; then
        log_info "Adding role to EKS cluster via IAM Access Entry..."
        local account_id=$(aws sts get-caller-identity --query Account --output text)
        local role_arn="arn:aws:iam::$account_id:role/$role_name"
        
        # Check if access entry already exists
        if aws eks describe-access-entry --cluster-name "$CLUSTER_NAME" --principal-arn "$role_arn" --region "$REGION" >/dev/null 2>&1; then
            log_info "Access entry already exists for role"
        else
            # Create access entry with cluster admin access
            aws eks create-access-entry \
                --cluster-name "$CLUSTER_NAME" \
                --principal-arn "$role_arn" \
                --type STANDARD \
                --region "$REGION" >/dev/null
            
            # Associate access policy for cluster admin permissions
            aws eks associate-access-policy \
                --cluster-name "$CLUSTER_NAME" \
                --principal-arn "$role_arn" \
                --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
                --access-scope type=cluster \
                --region "$REGION" >/dev/null
            
            log_success "Added IAM Access Entry with cluster admin policy"
        fi
    else
        log_info "No cluster name specified - skipping IAM Access Entry creation"
    fi
}

show_usage() {
    cat << EOF
Usage: $0 <command> [options]

Commands:
  deploy    Deploy the CDK stack
  destroy   Destroy the CDK stack

Deploy Options:
  -n, --target-nlb URL          Target URL for NLB environment (required)
  -h, --target-heimdall URL     Target URL for Heimdall environment (required)
  -e, --ecr-repo NAME           ECR repository name (required)
  -c, --cluster NAME            EKS cluster name (required)
  -a, --report-api-url URL      Report API URL (required)
  -k, --report-api-key KEY      Report API key (required)
  -r, --region REGION           AWS region (default: us-east-1)

Destroy Options:
  -c, --cluster NAME            EKS cluster name (optional, for IAM access cleanup)
  -r, --region REGION           AWS region (default: us-east-1)

Examples:
  $0 deploy \\
    --target-nlb http://nlb.example.com/bidrequest \\
    --target-heimdall http://heimdall.example.com/bidrequest \\
    --ecr-repo load-gen \\
    --cluster my-eks-cluster \\
    --report-api-url https://api.example.com/report \\
    --report-api-key api-key-123 \\
    --region us-east-1

  $0 destroy --cluster my-eks-cluster --region us-east-1
  $0 destroy
EOF
}

deploy_stack() {
    # Initialize variables
    TARGET_NLB=""
    TARGET_HEIMDALL=""
    ECR_REPOSITORY_NAME=""
    CLUSTER_NAME=""
    REPORT_API_URL=""
    REPORT_API_KEY=""
    REGION="us-east-1"

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            -n|--target-nlb)
                TARGET_NLB="$2"
                shift 2
                ;;
            -h|--target-heimdall)
                TARGET_HEIMDALL="$2"
                shift 2
                ;;
            -e|--ecr-repo)
                ECR_REPOSITORY_NAME="$2"
                shift 2
                ;;
            -c|--cluster)
                CLUSTER_NAME="$2"
                shift 2
                ;;
            -a|--report-api-url)
                REPORT_API_URL="$2"
                shift 2
                ;;
            -k|--report-api-key)
                REPORT_API_KEY="$2"
                shift 2
                ;;
            -r|--region)
                REGION="$2"
                shift 2
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    # Validate required arguments
    if [[ -z "$TARGET_NLB" ]] || [[ -z "$TARGET_HEIMDALL" ]] || [[ -z "$ECR_REPOSITORY_NAME" ]] || [[ -z "$CLUSTER_NAME" ]] || [[ -z "$REPORT_API_URL" ]] || [[ -z "$REPORT_API_KEY" ]]; then
        log_error "Missing required arguments"
        show_usage
        exit 1
    fi

    log_info "Deploying with CDK..."
    log_info "  Target NLB: $TARGET_NLB"
    log_info "  Target Heimdall: $TARGET_HEIMDALL"
    log_info "  ECR Repository: $ECR_REPOSITORY_NAME"
    log_info "  Cluster: $CLUSTER_NAME"
    log_info "  Region: $REGION"
    log_info "  Report API URL: $REPORT_API_URL"
    log_info "  Report API Key: ${REPORT_API_KEY:0:10}..."

    # Check prerequisites
    command -v python3 >/dev/null 2>&1 || { log_error "python3 is required"; exit 1; }
    command -v npm >/dev/null 2>&1 || { log_error "npm is required for CDK"; exit 1; }

    # Install CDK if not present
    if ! command -v cdk >/dev/null 2>&1; then
        log_info "Installing AWS CDK..."
        npm install -g aws-cdk
    fi

    # Setup Python environment
    cd cdk
    if [[ ! -d "venv" ]]; then
        log_info "Creating Python virtual environment..."
        python3 -m venv venv
    fi

    source venv/bin/activate
    pip install -r requirements.txt

    # Build context arguments
    CONTEXT_ARGS="-c target_nlb=$TARGET_NLB -c target_heimdall=$TARGET_HEIMDALL -c ecr_repository_name=$ECR_REPOSITORY_NAME -c region=$REGION -c cluster_name=$CLUSTER_NAME -c report_api_url=$REPORT_API_URL -c report_api_key=$REPORT_API_KEY"

    # Bootstrap CDK if needed
    log_info "Bootstrapping CDK environment..."
    cdk bootstrap $CONTEXT_ARGS --toolkit-stack-name CDKToolkit-Lambda-Loadgen --qualifier loadgen aws://$(aws sts get-caller-identity --query Account --output text)/$REGION

    # Deploy
    log_info "Deploying stack..."
    cdk deploy $CONTEXT_ARGS --toolkit-stack-name CDKToolkit-Lambda-Loadgen --require-approval never

    log_success "🎉 Deployment completed successfully!"

    # Configure EKS access automatically if cluster name provided
    if [[ -n "$CLUSTER_NAME" ]]; then
        configure_eks_auth "lambda-eks-helm-role"
    fi

    # Get outputs
    log_info "Getting stack outputs..."
    OUTPUTS=$(aws cloudformation describe-stacks --stack-name LambdaHelmStack --query 'Stacks[0].Outputs' --output json --region "$REGION")
    API_ENDPOINT=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="ApiEndpoint") | .OutputValue')
    API_KEY_ID=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="ApiKeyId") | .OutputValue')

    if [[ -n "$API_ENDPOINT" ]] && [[ -n "$API_KEY_ID" ]]; then
        # Get API key value
        API_KEY_VALUE=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value --region "$REGION" --query 'value' --output text)
        
        log_success "🎉 Deployment completed successfully!"
        echo ""
        log_info "Test via API Gateway:"
        echo "# Start load generator:"
        echo "curl -X POST ${API_ENDPOINT}start \\"
        echo "  -H 'Content-Type: application/json' \\"
        echo "  -H 'x-api-key: $API_KEY_VALUE' \\"
        echo "  -d '{"
        echo "    \"duration\": \"10m\","
        echo "    \"devicesUsed\": \"1000\","
        echo "    \"numberOfJobs\": \"1\","
        echo "    \"ratePerJob\": \"0\","
        echo "    \"rtbEnv\": \"nlb\""
        echo "  }'"
        echo ""
        echo "# Stop load generator:"
        echo "curl -X POST ${API_ENDPOINT}stop \\"
        echo "  -H 'Content-Type: application/json' \\"
        echo "  -H 'x-api-key: $API_KEY_VALUE' \\"
        echo "  -d '{}'"
    fi
}

remove_eks_auth() {
    local role_name="$1"
    
    if [[ -n "$CLUSTER_NAME" ]]; then
        log_info "Removing role from EKS cluster IAM Access Entry..."
        local account_id=$(aws sts get-caller-identity --query Account --output text)
        local role_arn="arn:aws:iam::$account_id:role/$role_name"
        
        # Check if access entry exists and delete it
        if aws eks describe-access-entry --cluster-name "$CLUSTER_NAME" --principal-arn "$role_arn" --region "$REGION" >/dev/null 2>&1; then
            aws eks delete-access-entry \
                --cluster-name "$CLUSTER_NAME" \
                --principal-arn "$role_arn" \
                --region "$REGION" >/dev/null
            log_success "Removed IAM Access Entry"
        else
            log_info "Access entry not found for role"
        fi
    fi
}

destroy_stack() {
    log_info "Destroying CDK stack..."
    
    # Initialize variables
    CLUSTER_NAME=""
    REGION="us-east-1"
    
    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            -c|--cluster)
                CLUSTER_NAME="$2"
                shift 2
                ;;
            -r|--region)
                REGION="$2"
                shift 2
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
    
    log_info "Destroying with parameters:"
    log_info "  Cluster: ${CLUSTER_NAME:-"none"}"
    log_info "  Region: $REGION"
    
    # Setup Python environment
    cd cdk
    if [[ -d "venv" ]]; then
        source venv/bin/activate
    else
        log_error "CDK environment not found. Run deploy first."
        exit 1
    fi
    
    # Remove from EKS aws-auth if cluster specified
    if [[ -n "$CLUSTER_NAME" ]]; then
        remove_eks_auth "lambda-eks-helm-role"
    fi
    
    # Destroy CDK stack
    cdk destroy --force --toolkit-stack-name CDKToolkit-Lambda-Loadgen -c region=$REGION -c target_nlb=dummy -c target_heimdall=dummy -c ecr_repository_name=dummy
    
    log_success "Stack destroyed successfully!"
}

# Parse command
COMMAND=${1}
if [[ -z "$COMMAND" ]]; then
    log_error "Command is required"
    show_usage
    exit 1
fi

case "$COMMAND" in
    "deploy")
        shift
        deploy_stack "$@"
        ;;
    "destroy")
        shift
        destroy_stack "$@"
        ;;
    *)
        log_error "Unknown command: $COMMAND"
        show_usage
        exit 1
        ;;
esac
