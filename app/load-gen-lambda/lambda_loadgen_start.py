import json
import os
import subprocess
import tempfile
import boto3
from typing import Dict, Any

# Constants
TMP_DIR = '/tmp'
CHART_PATH = '/tmp/load-generator'
KUBECTL_CACHE_DIR = '/tmp/.kube/cache'
KUBECTL_BASE_DIR = '/tmp/.kube'

# Timeouts (in seconds)
KUBECTL_TIMEOUT = 30
HELM_TIMEOUT = 300
HELM_STATUS_TIMEOUT = 30
HELM_LINT_TIMEOUT = 30

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    AWS Lambda function to deploy Helm chart to EKS cluster
    
    Environment variables:
    - EKS_CLUSTER_NAME: Name of the EKS cluster (optional - will auto-discover if not set)
    - EKS_REGION: AWS region (optional - defaults to AWS_REGION or us-east-1)
    - TARGET_NLB: Target URL for NLB environment (optional - can be overridden by event parameter)
    - TARGET_HEIMDALL: Target URL for Heimdall environment (optional - can be overridden by event parameter)
    - ECR_REPOSITORY_NAME: Name for the Helm release (required)
    - PATH: Must include /opt/bin for the layer binaries
    
    Event parameters:
    - cluster_name: EKS cluster name (optional - overrides environment variable and auto-discovery)
    - target: Target URL for load testing (optional - overrides environment variable based on rtbEnv)
    - duration: Load test duration (optional - default: 10m, format: number + 'm')
    - numberOfJobs: Number of parallel jobs (optional - default: 1)
    - devicesUsed: Number of devices to simulate (optional - default: 1000)
    - ratePerJob: Rate per job (optional - default: 0)
    - rtbEnv: RTB environment value (required - 'nlb' or 'heimdall')
    """
    
    try:
        print(f"Received event: {event}")
        print(f"Environment variables: ECR_REPOSITORY_NAME={os.environ.get('ECR_REPOSITORY_NAME')}, TARGET_NLB={os.environ.get('TARGET_NLB')}, TARGET_HEIMDALL={os.environ.get('TARGET_HEIMDALL')}")
        
        # Handle API Gateway event format
        if 'body' in event:
            if event['body']:
                try:
                    print(f"Raw API Gateway body: {repr(event['body'])}")
                    body = json.loads(event['body'])
                    print(f"Parsed API Gateway body: {body}")
                    event = body
                except json.JSONDecodeError as e:
                    error_msg = f"Invalid JSON in request body: {e}"
                    print(f"ERROR: {error_msg}")
                    print(f"Raw body content: {repr(event['body'])}")
                    raise ValueError(error_msg)
            else:
                print("Empty API Gateway body, using empty event")
                event = {}
        
        # Get configuration from environment variables or event
        # Use EKS_REGION first, then fall back to AWS_REGION (automatically set by Lambda), then default
        aws_region = os.environ.get('EKS_REGION') or os.environ.get('AWS_REGION', 'us-east-1')
        
        # Get cluster name with priority: event > environment > auto-discovery
        cluster_name = event.get('cluster_name') or os.environ.get('EKS_CLUSTER_NAME')
        if not cluster_name:
            print("No cluster_name provided in event or EKS_CLUSTER_NAME environment variable, auto-discovering...")
            cluster_name = get_eks_cluster_name(aws_region)
        else:
            print(f"Using specified cluster: {cluster_name}")
        
        # Static chart path in writable /tmp directory
        chart_path = CHART_PATH
        
        # Get repository name from environment variable
        ecr_repository_name = os.environ.get('ECR_REPOSITORY_NAME')
        if not ecr_repository_name:
            raise ValueError("ECR_REPOSITORY_NAME environment variable is required")
        
        # Get rtb_env from event parameter (required)
        rtb_env = event.get('rtbEnv')
        if not rtb_env:
            raise ValueError("rtbEnv parameter is required in event payload")
        
        # Determine target URL based on rtbEnv
        # Priority: event parameter > environment variable based on rtbEnv
        target = event.get('target')
        if not target:
            # Select environment variable based on rtbEnv value
            if rtb_env.lower() == 'nlb':
                target = os.environ.get('TARGET_NLB')
                if not target:
                    raise ValueError("TARGET_NLB environment variable is required when rtbEnv='nlb' and no target parameter is provided")
            elif rtb_env.lower() == 'heimdall':
                target = os.environ.get('TARGET_HEIMDALL')
                if not target:
                    raise ValueError("TARGET_HEIMDALL environment variable is required when rtbEnv='heimdall' and no target parameter is provided")
            else:
                raise ValueError(f"Invalid rtbEnv value: '{rtb_env}'. Must be 'nlb' or 'heimdall'")
        
        # Get and validate duration parameter
        duration = event.get('duration', '10m')
        validate_duration_format(duration)
        
        # Get and validate devices parameter
        devices_used = event.get('devicesUsed', '1000')
        validate_devices_count(devices_used)
        
        print(f"Starting deployment to EKS cluster: {cluster_name} in region: {aws_region}")
        print(f"Target URL: {target}")
        print(f"Duration: {duration}")
        print(f"Devices: {devices_used}")
        print(f"RTB Environment: {rtb_env}")
        
        # Initialize AWS client
        eks_client = boto3.client('eks', region_name=aws_region)
        
        # Get cluster information
        cluster_info = get_cluster_info(eks_client, cluster_name)
        
        # Generate kubeconfig
        kubeconfig_path = generate_kubeconfig(cluster_info, aws_region, cluster_name)
        
        # Setup kubectl environment
        setup_kubectl_environment(kubeconfig_path)
        
        # Verify kubectl connectivity
        verify_kubectl_connection()
        
        # Generate Helm chart (if needed)
        generate_helm_chart(chart_path)
        
        # Deploy Helm chart
        deploy_helm_chart(
            chart_path, 
            aws_region,
            ecr_repository_name=ecr_repository_name,
            duration=duration,
            numberOfJobs=event.get('numberOfJobs', '1'),
            devicesUsed=devices_used,
            ratePerJob=event.get('ratePerJob', '0'),
            target=target,
            rtb_env=rtb_env
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'POST,OPTIONS'
            },
            'body': json.dumps({
                'message': 'Helm chart deployed successfully',
                'cluster': cluster_name,
                'region': aws_region
            })
        }
        
    except Exception as e:
        print(f"Error: {e}")
        error_response = {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'POST,OPTIONS'
            },
            'body': json.dumps({
                'error': str(e)
            })
        }
        print(f"Returning error response: {error_response}")
        return error_response

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
    print(f"Set kubectl cache directory to: {KUBECTL_CACHE_DIR}")

def write_file_safely(file_path: str, content: str, description: str) -> None:
    """Write content to file with proper error handling"""
    try:
        with open(file_path, 'w') as f:
            f.write(content)
        print(f"✅ Created {description}: {file_path}")
    except OSError as e:
        raise Exception(f"Failed to write {description} to {file_path}: {e}")
    except Exception as e:
        raise Exception(f"Unexpected error writing {description}: {e}")

def get_cluster_info(eks_client: boto3.client, cluster_name: str) -> Dict[str, Any]:
    """Get EKS cluster information"""
    try:
        response = eks_client.describe_cluster(name=cluster_name)
        return response['cluster']
    except Exception as e:
        raise Exception(f"Failed to get cluster info: {str(e)}")

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
        print(f"Using direct token authentication with eks-token package")
        return kubeconfig_path
        
    except Exception as e:
        # Clean up file descriptor if something goes wrong
        try:
            os.close(kubeconfig_fd)
        except:
            pass
        raise Exception(f"Failed to generate kubeconfig: {str(e)}")

def get_eks_token(cluster_name: str, region: str) -> str:
    """Generate EKS authentication token using eks-token package"""
    try:
        from eks_token import get_token
        
        print(f"Generating EKS token for cluster {cluster_name} in region {region}")
        
        # Set AWS_DEFAULT_REGION environment variable for eks-token
        original_region = os.environ.get('AWS_DEFAULT_REGION')
        os.environ['AWS_DEFAULT_REGION'] = region
        
        try:
            # Use the eks-token package to generate the token
            # The eks-token package uses cluster_name as the only parameter
            # and gets the region from AWS_DEFAULT_REGION environment variable
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

def verify_kubectl_connection() -> None:
    """Verify kubectl can connect to the cluster"""
    try:
        result = subprocess.run(
            ['kubectl', 'cluster-info'],
            capture_output=True,
            text=True,
            check=True,
            timeout=KUBECTL_TIMEOUT
        )
        print("✅ kubectl connection verified successfully")
        
    except subprocess.CalledProcessError as e:
        print(f"❌ kubectl connection failed with return code {e.returncode}")
        print(f"Error output: {e.stderr}")
        raise Exception(f"kubectl connection failed: {e.stderr}")
    except subprocess.TimeoutExpired:
        print("❌ kubectl connection timed out")
        raise Exception("kubectl connection timed out")
    except Exception as e:
        print(f"❌ Unexpected error in kubectl verification: {e}")
        raise Exception(f"kubectl connection failed: {e}")

def generate_helm_chart(chart_path: str) -> None:
    """Generate complete Helm chart structure programmatically"""
    try:
        # Check if chart directory exists
        if not os.path.exists(chart_path):
            print(f"Chart path {chart_path} does not exist, creating complete chart structure...")
            
            # Create chart directory structure with error handling
            try:
                os.makedirs(chart_path, exist_ok=True)
                os.makedirs(f"{chart_path}/templates", exist_ok=True)
                print(f"✅ Created chart directory structure at {chart_path}")
            except OSError as e:
                raise Exception(f"Failed to create chart directories: {e}")
            except Exception as e:
                raise Exception(f"Unexpected error creating directories: {e}")
            
            # Create Chart.yaml
            chart_yaml_content = """apiVersion: v2
name: load-generator
description: Load generator
type: application

# This is the chart version. This version number should be incremented each time you make changes
# to the chart and its templates, including the app version.
# Versions are expected to follow Semantic Versioning (https://semver.org/)
version: 0.1.0

# This is the version number of the application being deployed. This version number should be
# incremented each time you make changes to the application. Versions are not expected to
# follow Semantic Versioning. They should reflect the version the application is using.
# It is recommended to use it with quotes.
appVersion: "latest"
"""
            write_file_safely(f"{chart_path}/Chart.yaml", chart_yaml_content, "Chart.yaml")
            
            # Create .helmignore
            helmignore_content = """# Patterns to ignore when building packages.
# This supports shell glob matching, relative path matching, and
# negation (prefixed with !). Only one pattern per line.
.DS_Store
# Common VCS dirs
.git/
.gitignore
.bzr/
.bzrignore
.hg/
.hgignore
.svn/
# Common backup files
*.swp
*.bak
*.tmp
*.orig
*~
# Various IDEs
.project
.idea/
*.tmproj
.vscode/
"""
            write_file_safely(f"{chart_path}/.helmignore", helmignore_content, ".helmignore")
            
            # Create values.yaml
            values_yaml_content = """# Default values for load-generator.
# This is a YAML-formatted file.
# Declare variables to be passed into your templates.

# Load generator arguments.
duration: "6s"
timeout: "100ms"
startDelay: "1s"
devicesUsed: 1000000000
ratePerJob: 100
workers: 4096
enableProfiler: false
# These three are used only when enableProfiler is true.
profilerOutput: "pprof-{{.Endpoint}}-{{.Hostname}}"
profilerBucket: "aws-bidder-benchmark-files"
profilerUrl: http://bidder-internal:8091/debug/pprof/
trackErrors: true

# Target options (in order of precedence).
targets:
  # Dynamic targets generation.
  dynamic:
    count: 0
    template: "https://{{ .Values.stackName }}{{ .suffix }}/bidrequest"
    suffixTemplate: "{{- if gt .index 0 -}}-{{ add1 .index }}{{ end }}"

  # Static list of target URLs.
  static: []

# Job parameters.
numberOfJobs: 1
awsRegion: us-east-1
stackName: ""

image:
  # Set this to ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com
  registry: ""
  # Repository within the ECR registry.
  repository: load-generator
  # Pull policy is determine in the following way: 1) if specified here, the value is used; 2) if the tag is 'latest',
  # the pull policy is Always (since the latest tag changes), 3) otherwise IfNotPresent is used (since the tag likely
  # corresponds to a git commit hash or a git tag that does not change in our repo).
  # pullPolicy: Always
  # Overrides the image tag whose default is the chart appVersion.
  tag: "latest"

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  # Annotations to add to the service account
  annotations: {}
  # The name of the service account to use.
  # If not set, a name is generated using the fullname template
  name: ""

podAnnotations: {}

podSecurityContext:
  fsGroup: 3000 # to be able to read Kubernetes and AWS token files

securityContext: {}
  # capabilities:
  #   drop:
  #   - ALL
  # readOnlyRootFilesystem: true
  # runAsNonRoot: true
  # runAsUser: 1000

resources: {}
  # We usually recommend not to specify default resources and to leave this as a conscious
  # choice for the user. This also increases chances charts run on environments with little
  # resources, such as Minikube. If you do want to specify resources, uncomment the following
  # lines, adjust them as necessary, and remove the curly braces after 'resources:'.
#  limits:
#    cpu: 59000m
#    memory: 200000Mi
#  requests:
#    cpu: 59000m
#    memory: 200000Mi

nodeSelector:
  pool: benchmark

# Report API configuration
reportApi:
  # REST API URL to send the final report to
  url: ""
  # API key for authentication
  apiKey: ""
  # RTB environment
  rtbEnv: ""

# Wait until target is available.
# Deploys initial container that holds on the load generator until the target is available.
waitForService:
  enable: false
  # This image is within our ECR registry.
  image: alpine:3.12.2
  healthCheckPath: /healthz
"""
            write_file_safely(f"{chart_path}/values.yaml", values_yaml_content, "values.yaml")
            
            # Create templates/job.yaml
            job_yaml_content = """apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "load-generator.fullname" . }}
  labels:
    {{- include "load-generator.labels" . | nindent 4 }}
spec:
  ttlSecondsAfterFinished: 10
  parallelism: {{ .Values.numberOfJobs }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "load-generator.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "load-generator.serviceAccountName" . }}
      restartPolicy: Never
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ include "load-generator.imagePullPolicy" . }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          env:
            - name: AWS_REGION
              value: {{ .Values.awsRegion }}
            - name: GOMAXPROCS
              value: {{ include "load-generator.gomaxprocs" . }}
          args:
            {{- include "load-generator.evaluateTargets" $ }}
            {{- range $.targets }}
            - --target={{ . }}
            {{- end }}
            - --duration={{ .Values.duration }}
            - --timeout={{ .Values.timeout }}
            - --start-delay={{ .Values.startDelay }}
            - --devices-used={{ printf "%d" (.Values.devicesUsed | int64) }}
            - --initial-rate={{ printf "%d" (.Values.ratePerJob | int64) }}
            - --workers={{ printf "%d" (.Values.workers | int64) }}
            {{ if .Values.enableProfiler -}}
            - --profiler-url={{ .Values.profilerUrl }}
            - --profiler-bucket={{ .Values.profilerBucket }}
            - --profiler-output={{ .Values.profilerOutput }}
            {{- end }}
            - --track-errors={{ .Values.trackErrors }}
            {{- if .Values.reportApi.url }}
            - --report-api-url={{ .Values.reportApi.url }}
            {{- end }}
            {{- if .Values.reportApi.apiKey }}
            - --report-api-key={{ .Values.reportApi.apiKey }}
            {{- end }}
            {{- if .Values.reportApi.rtbEnv }}
            - --rtb-env={{ .Values.reportApi.rtbEnv }}
            {{- end }}
      {{- if $.Values.waitForService.enable }}
      initContainers:
        - name: wait-for-service
          image: "{{ .Values.public_ecr_registry }}/{{ .Values.waitForService.image }}"
          env:
            - name: TARGETS
              value: {{ include "load-generator.waitForServiceTargets" $ }}
          args:
            - 'sh'
            - '-c'
            - |
              for TARGET in $TARGETS; do
                until wget --spider --no-check-certificate -T 5 $TARGET; do
                  echo "Still waiting for $TARGET..."
                  sleep 1;
                done;
              done;
      {{- end }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
"""
            write_file_safely(f"{chart_path}/templates/job.yaml", job_yaml_content, "templates/job.yaml")
            
            # Create templates/serviceaccount.yaml
            serviceaccount_yaml_content = """apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "load-generator.serviceAccountName" . }}
  labels:
    {{- include "load-generator.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
"""
            write_file_safely(f"{chart_path}/templates/serviceaccount.yaml", serviceaccount_yaml_content, "templates/serviceaccount.yaml")
            
            # Create templates/_helpers.tpl
            helpers_tpl_content = """{{/*
Expand the name of the chart.
*/}}
{{- define "load-generator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "load-generator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "load-generator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "load-generator.labels" -}}
helm.sh/chart: {{ include "load-generator.chart" . }}
{{ include "load-generator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "load-generator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "load-generator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app: load-generator
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "load-generator.serviceAccountName" -}}
{{- default (include "load-generator.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
Image pull policy for the specified image tag.
*/}}
{{- define "load-generator.imagePullPolicy" -}}
{{- if .Values.image.pullPolicy -}}
{{ .Values.image.pullPolicy }}
{{- else if eq .Values.image.tag "latest" -}}
Always
{{- else -}}
IfNotPresent
{{- end -}}
{{- end }}

{{/*
Evaluates and creates a list of targets from the first available source of configuration:
- static targets (.Values.targets.static)
- single target (.Values.target)

The list is exposed as $.targets.
*/}}
{{- define "load-generator.evaluateTargets" -}}
{{- if .Values.targets.static -}}
    {{- $_ := set $ "targets" .Values.targets.static -}}
{{- else -}}
    {{- $_ := set $ "targets" (list .Values.target) -}}
{{- end -}}
{{- end -}}

{{/*
Target URL for wait-for-service initial container.
*/}}
{{- define "load-generator.waitForServiceTargets" -}}
{{- range $.targets -}}
{{ " " }}{{ . -}}
{{- end -}}
{{- end -}}

{{/*
Expand to the GOMAXPROCS config key if it's absent from values config and the
load-generator has a corresponding CPU limit.
*/}}
{{- define "load-generator.gomaxprocs" -}}
{{- if .Values.resources.limits -}}
{{- if .Values.resources.limits.cpu -}}
{{ .Values.resources.limits.cpu | regexReplaceAll "m$" "" }}
{{- else -}}
""
{{- end -}}
{{- else -}}
""
{{- end -}}
{{- end }}
"""
            write_file_safely(f"{chart_path}/templates/_helpers.tpl", helpers_tpl_content, "templates/_helpers.tpl")
            
            print(f"Created complete Helm chart structure at {chart_path}")
        
        # Validate chart
        try:
            result = subprocess.run(
                ['helm', 'lint', chart_path],
                capture_output=True,
                text=True,
                timeout=HELM_LINT_TIMEOUT
            )
            
            if result.returncode != 0:
                print(f"Helm lint warnings/errors: {result.stderr}")
                print(f"Helm lint output: {result.stdout}")
            else:
                print("✅ Helm chart validation successful")
        except subprocess.TimeoutExpired:
            raise Exception("Helm chart validation timed out")
        except FileNotFoundError:
            raise Exception("helm command not found - ensure helm is installed and in PATH")
        except Exception as e:
            raise Exception(f"Failed to validate Helm chart: {e}")
            
    except subprocess.TimeoutExpired:
        raise Exception("Helm chart generation timed out")
    except Exception as e:
        raise Exception(f"Failed to generate/validate Helm chart: {e}")

def validate_duration_format(duration: str) -> None:
    # # """Validate that duration parameter has correct format (number + 's' or 'm') and max 10m"""
    # import re
    
    # # Pattern: one or more digits followed by 's' or 'm'
    # pattern = r'^(\d+)([sm])$'
    
    # match = re.match(pattern, duration)
    # if not match:
    #     raise ValueError(f"Invalid duration format: '{duration}'. Duration must be a number followed by 's' or 'm' (e.g., '30s', '5m', '10m')")
    
    # # Check maximum duration of 10 minutes (convert seconds to minutes if needed)
    # value = int(match.group(1))
    # unit = match.group(2)
    
    # if unit == 'm':
    #     minutes = value
    # else:  # unit == 's'
    #     minutes = value / 60
    
    # if minutes > 10:
    #     raise ValueError(f"Duration too long: '{duration}'. Maximum allowed duration is 10m")
    
    print(f"✅ Duration format validated: {duration}")

def validate_devices_count(devices: str) -> None:
    """Validate that devices count is within allowed range (max 1000)"""
    try:
        device_count = int(devices)
        if device_count > 1000:
            raise ValueError(f"Too many devices: {device_count}. Maximum allowed devices is 1000")
        if device_count < 1:
            raise ValueError(f"Invalid device count: {device_count}. Must be at least 1")
        print(f"✅ Device count validated: {device_count}")
    except ValueError as e:
        if "invalid literal" in str(e):
            raise ValueError(f"Invalid device count format: '{devices}'. Must be a number")
        raise

def get_eks_cluster_name(region: str) -> str:
    """Programmatically discover the EKS cluster name in the account"""
    try:
        print(f"Auto-discovering EKS clusters in region: {region}")
        eks_client = boto3.client('eks', region_name=region)
        
        # List all clusters in the region
        print("Calling EKS list_clusters API...")
        response = eks_client.list_clusters()
        clusters = response.get('clusters', [])
        
        print(f"Found {len(clusters)} EKS cluster(s): {clusters}")
        
        if len(clusters) == 0:
            raise Exception("No EKS clusters found in the account")
        elif len(clusters) == 1:
            cluster_name = clusters[0]
            print(f"✅ Auto-discovered single EKS cluster: {cluster_name}")
            return cluster_name
        else:
            # Multiple clusters found, list them for reference
            cluster_list = ', '.join(clusters)
            print(f"❌ Multiple EKS clusters found ({len(clusters)}): {cluster_list}")
            raise Exception(f"Multiple EKS clusters found ({len(clusters)}): {cluster_list}. Please specify cluster_name in event payload to choose which one to use.")
        
    except Exception as e:
        print(f"❌ Failed to discover EKS cluster: {str(e)}")
        raise Exception(f"Failed to discover EKS cluster: {str(e)}")

def get_ecr_registry_url(region: str) -> str:
    """Get ECR registry URL for the current AWS account and region"""
    try:
        # Get current AWS account ID
        sts_client = boto3.client('sts', region_name=region)
        account_id = sts_client.get_caller_identity()['Account']
        
        # Construct ECR registry URL
        ecr_registry = f"{account_id}.dkr.ecr.{region}.amazonaws.com"
        
        print(f"Retrieved ECR registry URL: {ecr_registry}")
        return ecr_registry
        
    except Exception as e:
        raise Exception(f"Failed to get ECR registry URL: {str(e)}")

def deploy_helm_chart(chart_path: str, region: str, ecr_repository_name: str, duration: str, 
                      numberOfJobs: str, devicesUsed: str, ratePerJob: str, target: str, rtb_env: str = '') -> None:
    """Deploy Helm chart with specified configuration"""
    
    # Get ECR registry URL programmatically
    ecr_registry = get_ecr_registry_url(region)
    
    print(f"Using Helm parameters:")
    print(f"  duration: {duration}")
    print(f"  numberOfJobs: {numberOfJobs}")
    print(f"  devicesUsed: {devicesUsed}")
    print(f"  ratePerJob: {ratePerJob}")
    print(f"  target: {target}")
    print(f"  image.repository: {ecr_repository_name}")
    print(f"  rtbEnv: {rtb_env}")
    
    # Get report API configuration from environment variables
    report_api_url = os.environ.get('REPORT_API_URL', '')
    report_api_key = os.environ.get('REPORT_API_KEY', '')
    
    helm_command = [
        'helm', 'upgrade', '--install',
        '--set', f'image.registry={ecr_registry}',
        'load-generator', chart_path,
        '--set', f'duration={duration}',
        '--set', f'numberOfJobs={numberOfJobs}',
        '--set', f'devicesUsed={devicesUsed}',
        '--set', f'ratePerJob={ratePerJob}',
        '--set', f'target={target}',
        # '--set', 'profilerOutput=2025-08-13T15:07-Basic/pprof-{{.Endpoint}}-{{.Hostname}}',
        '--set', 'image.tag=latest',
        '--set', f'awsRegion={region}',
        '--set', 'nodeSelector.pool=benchmark',
        '--set', f'image.repository={ecr_repository_name}',
        '--set', 'waitForService.image=alpine',
        '--set', 'public_ecr_registry=public.ecr.aws/docker/library',
        '--set', f'reportApi.url={report_api_url}',
        '--set', f'reportApi.apiKey={report_api_key}',
        '--set', f'reportApi.rtbEnv={rtb_env}'
    ]
    
    try:
        print("Deploying Helm chart...")
        print(f"Using ECR registry: {ecr_registry}")
        print(f"Command: {' '.join(helm_command)}")
        
        result = subprocess.run(
            helm_command,
            capture_output=True,
            text=True,
            check=True,
            timeout=HELM_TIMEOUT  # 5 minutes timeout
        )
        
        print("Helm deployment successful!")
        print(f"Output: {result.stdout}")
        
        # Get deployment status
        status_result = subprocess.run(
            ['helm', 'status', ecr_repository_name],
            capture_output=True,
            text=True,
            timeout=HELM_STATUS_TIMEOUT
        )
        
        if status_result.returncode == 0:
            print(f"Deployment status: {status_result.stdout}")
        
    except subprocess.CalledProcessError as e:
        raise Exception(f"Helm deployment failed: {e.stderr}")
    except subprocess.TimeoutExpired:
        raise Exception("Helm deployment timed out")

def cleanup_temp_files():
    """Clean up temporary files"""
    import shutil
    
    kubeconfig_path = os.environ.get('KUBECONFIG')
    if kubeconfig_path and os.path.exists(kubeconfig_path):
        try:
            os.remove(kubeconfig_path)
            print(f"Cleaned up temporary kubeconfig: {kubeconfig_path}")
        except Exception as e:
            print(f"Failed to clean up kubeconfig: {e}")
    
    # Clean up kubectl cache directory
    if os.path.exists(KUBECTL_BASE_DIR):
        try:
            shutil.rmtree(KUBECTL_BASE_DIR)
            print(f"Cleaned up kubectl cache directory: {KUBECTL_BASE_DIR}")
        except Exception as e:
            print(f"Failed to clean up cache directory: {e}")
    
    # Clean up helm chart directory
    if os.path.exists(CHART_PATH):
        try:
            shutil.rmtree(CHART_PATH)
            print(f"Cleaned up chart directory: {CHART_PATH}")
        except Exception as e:
            print(f"Failed to clean up chart directory: {e}")

# Register cleanup function
import atexit
atexit.register(cleanup_temp_files)

if __name__ == "__main__":
    # For local testing
    test_event = {
        'cluster_name': 'your-eks-cluster-name'
    }
    
    class MockContext:
        def __init__(self):
            self.function_name = 'test-function'
            self.aws_request_id = 'test-request-id'
    
    result = lambda_handler(test_event, MockContext())
    print(json.dumps(result, indent=2))
