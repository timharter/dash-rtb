import json
import subprocess
import os
import logging
import boto3
import tempfile
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TMP_DIR = '/tmp'
KUBECTL_CACHE_DIR = f'{TMP_DIR}/.kube'

def get_cluster_info(eks_client: boto3.client, cluster_name: str) -> Dict[str, Any]:
    """Get EKS cluster information"""
    try:
        response = eks_client.describe_cluster(name=cluster_name)
        return response['cluster']
    except Exception as e:
        raise Exception(f"Failed to get cluster info: {str(e)}")

def get_eks_token(cluster_name: str, region: str) -> str:
    """Generate EKS authentication token using eks-token package"""
    try:
        from eks_token import get_token
        
        print(f"Generating EKS token for cluster {cluster_name} in region {region}")
        
        # Set AWS_DEFAULT_REGION environment variable for eks-token
        original_region = os.environ.get('AWS_DEFAULT_REGION')
        os.environ['AWS_DEFAULT_REGION'] = region
        
        try:
            token = get_token(cluster_name)['status']['token']
            print(f"Successfully generated EKS token, length: {len(token)}")
            return token
            
        finally:
            # Restore original region environment variable
            if original_region is not None:
                os.environ['AWS_DEFAULT_REGION'] = original_region
            elif 'AWS_DEFAULT_REGION' in os.environ:
                del os.environ['AWS_DEFAULT_REGION']
        
    except ImportError:
        raise Exception("eks-token package not available. Please install with: pip install eks-token")
    except Exception as e:
        raise Exception(f"Failed to generate EKS token using eks-token package: {str(e)}")

def generate_kubeconfig(cluster_info: Dict[str, Any], region: str, cluster_name: str) -> str:
    """Generate kubeconfig file for EKS cluster with direct token authentication"""
    
    # Create temporary kubeconfig file
    kubeconfig_fd, kubeconfig_path = tempfile.mkstemp(suffix='.yaml', prefix='kubeconfig_')
    
    try:
        # Get cluster endpoint and certificate
        endpoint = cluster_info['endpoint']
        ca_cert = cluster_info['certificateAuthority']['data']
        
        # Generate token directly using eks-token package
        token = get_eks_token(cluster_name, region)
        
        # Generate kubeconfig content with direct token authentication
        kubeconfig_content = f"""apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: {ca_cert}
    server: {endpoint}
  name: {cluster_name}
contexts:
- context:
    cluster: {cluster_name}
    user: {cluster_name}
  name: {cluster_name}
current-context: {cluster_name}
kind: Config
preferences: {{}}
users:
- name: {cluster_name}
  user:
    token: {token}
"""
        
        # Write kubeconfig to file
        with os.fdopen(kubeconfig_fd, 'w') as f:
            f.write(kubeconfig_content)
        
        print(f"Generated kubeconfig at: {kubeconfig_path}")
        return kubeconfig_path
        
    except Exception as e:
        # Clean up file descriptor if something goes wrong
        try:
            os.close(kubeconfig_fd)
        except:
            pass
        raise Exception(f"Failed to generate kubeconfig: {str(e)}")

def setup_kubectl_environment(kubeconfig_path: str) -> None:
    """Setup kubectl environment variables and cache directory"""
    # Set KUBECONFIG environment variable
    os.environ['KUBECONFIG'] = kubeconfig_path
    
    # Set kubectl cache directory to writable location in Lambda
    os.environ['KUBE_CACHE_DIR'] = KUBECTL_CACHE_DIR
    os.environ['HOME'] = TMP_DIR
    
    # Create cache directory if it doesn't exist
    os.makedirs(KUBECTL_CACHE_DIR, exist_ok=True)
    
    print(f"Set KUBECONFIG to: {kubeconfig_path}")

def lambda_handler(event, context):
    try:
        # Get cluster name from environment
        cluster_name = os.environ.get('EKS_CLUSTER_NAME')
        region = os.environ.get('EKS_REGION')
        
        if not cluster_name:
            return {
                'statusCode': 400,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                    'Access-Control-Allow-Methods': 'POST,OPTIONS'
                },
                'body': json.dumps({'error': 'EKS_CLUSTER_NAME not configured'})
            }
        
        # Get EKS cluster info
        eks_client = boto3.client('eks', region_name=region)
        cluster_info = get_cluster_info(eks_client, cluster_name)
        
        # Generate kubeconfig
        kubeconfig_path = generate_kubeconfig(cluster_info, region, cluster_name)
        
        # Setup kubectl environment
        setup_kubectl_environment(kubeconfig_path)
        
        # Delete the load generator job
        result = subprocess.run([
            '/opt/bin/kubectl', 'delete', 'job', 'load-generator'
        ], capture_output=True, text=True)
        
        if result.returncode == 0:
            logger.info("Load generator job deleted successfully")
            return {
                'statusCode': 200,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                    'Access-Control-Allow-Methods': 'POST,OPTIONS'
                },
                'body': json.dumps({'message': 'Load generator stopped successfully'})
            }
        else:
            logger.error(f"Failed to delete job: {result.stderr}")
            return {
                'statusCode': 500,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                    'Access-Control-Allow-Methods': 'POST,OPTIONS'
                },
                'body': json.dumps({'error': f'Failed to stop load generator: {result.stderr}'})
            }
            
    except Exception as e:
        logger.error(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'POST,OPTIONS'
            },
            'body': json.dumps({'error': str(e)})
        }
