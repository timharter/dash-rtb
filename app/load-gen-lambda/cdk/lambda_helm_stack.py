import aws_cdk as cdk
from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_iam as iam,
    aws_apigateway as apigateway,
    Duration,
    CfnOutput
)
from constructs import Construct
import subprocess
import os

class LambdaHelmStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, target_nlb: str, target_heimdall: str,
                 ecr_repository_name: str, cluster_name: str = None, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Create IAM role for Lambda
        lambda_role = iam.Role(
            self, "LambdaEksHelmRole",
            role_name="lambda-eks-helm-role",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSLambdaBasicExecutionRole")
            ],
            inline_policies={
                "EKSAccess": iam.PolicyDocument(
                    statements=[
                        iam.PolicyStatement(
                            effect=iam.Effect.ALLOW,
                            actions=["eks:DescribeCluster", "eks:ListClusters"],
                            resources=["*"]
                        ),
                        iam.PolicyStatement(
                            effect=iam.Effect.ALLOW,
                            actions=["sts:GetCallerIdentity"],
                            resources=["*"]
                        )
                    ]
                )
            }
        )

        # Build Lambda layer
        layer_path = self._build_layer()
        
        # Create Lambda layer
        kubectl_helm_layer = _lambda.LayerVersion(
            self, "KubectlHelmLayer",
            layer_version_name="kubectl-helm-layer",
            code=_lambda.Code.from_asset(layer_path),
            compatible_runtimes=[
                _lambda.Runtime.PYTHON_3_9,
                _lambda.Runtime.PYTHON_3_10,
                _lambda.Runtime.PYTHON_3_11,
                _lambda.Runtime.PYTHON_3_12,
                _lambda.Runtime.PYTHON_3_13
            ],
            description="kubectl and helm binaries for Lambda"
        )

        # Environment variables
        env_vars = {
            "EKS_REGION": self.region,
            "PATH": "/opt/bin:/usr/local/bin:/usr/bin/:/bin",
            "TARGET_NLB": target_nlb,
            "TARGET_HEIMDALL": target_heimdall,
            "ECR_REPOSITORY_NAME": ecr_repository_name,
            "REPORT_API_URL": self.node.try_get_context("report_api_url") or "",
            "REPORT_API_KEY": self.node.try_get_context("report_api_key") or ""
        }
        
        if cluster_name:
            env_vars["EKS_CLUSTER_NAME"] = cluster_name

        # Create start Lambda function
        start_lambda_function = _lambda.Function(
            self, "StartSspLoadGen",
            function_name="start-ssp-load-gen",
            runtime=_lambda.Runtime.PYTHON_3_13,
            handler="lambda_loadgen_start.lambda_handler",
            code=_lambda.Code.from_asset(self._build_lambda_package()),
            role=lambda_role,
            layers=[kubectl_helm_layer],
            timeout=Duration.minutes(15),
            memory_size=512,
            architecture=_lambda.Architecture.ARM_64,
            environment=env_vars,
            description="Load generator start function"
        )

        # Create stop Lambda function
        stop_lambda_function = _lambda.Function(
            self, "StopSspLoadGen",
            function_name="stop-ssp-load-gen",
            runtime=_lambda.Runtime.PYTHON_3_13,
            handler="lambda_loadgen_stop.lambda_handler",
            code=_lambda.Code.from_asset(self._build_stop_lambda_package()),
            role=lambda_role,
            layers=[kubectl_helm_layer],
            timeout=Duration.minutes(5),
            memory_size=256,
            architecture=_lambda.Architecture.ARM_64,
            environment={
                "EKS_REGION": self.region,
                "PATH": "/opt/bin:/usr/local/bin:/usr/bin/:/bin",
                "EKS_CLUSTER_NAME": cluster_name if cluster_name else "",
                "TARGET_NLB": target_nlb,
                "TARGET_HEIMDALL": target_heimdall
            }
        )

        # Create API Gateway
        api = apigateway.RestApi(
            self, "LoadGenApi",
            rest_api_name="load-gen-api",
            description="REST API for load generator Lambda function",
            default_cors_preflight_options=apigateway.CorsOptions(
                allow_origins=["*"],
                allow_methods=["POST", "OPTIONS"],
                allow_headers=["Content-Type", "X-Amz-Date", "Authorization", "X-Api-Key", "X-Amz-Security-Token"]
            )
        )
        
        # Add Gateway Responses for CORS on errors (403, 401, 500, etc.)
        # This ensures CORS headers are returned even when API Gateway rejects the request
        api.add_gateway_response(
            "Unauthorized",
            type=apigateway.ResponseType.UNAUTHORIZED,
            response_headers={
                "Access-Control-Allow-Origin": "'*'",
                "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'"
            }
        )
        
        api.add_gateway_response(
            "Forbidden",
            type=apigateway.ResponseType.ACCESS_DENIED,
            response_headers={
                "Access-Control-Allow-Origin": "'*'",
                "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'"
            }
        )
        
        api.add_gateway_response(
            "Default4XX",
            type=apigateway.ResponseType.DEFAULT_4_XX,
            response_headers={
                "Access-Control-Allow-Origin": "'*'",
                "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'"
            }
        )
        
        api.add_gateway_response(
            "Default5XX",
            type=apigateway.ResponseType.DEFAULT_5_XX,
            response_headers={
                "Access-Control-Allow-Origin": "'*'",
                "Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'"
            }
        )

        # Create API key
        api_key = apigateway.ApiKey(
            self, "LoadGenApiKey",
            api_key_name="load-gen-api-key",
            description="API key for load generator"
        )

        # Create usage plan
        usage_plan = apigateway.UsagePlan(
            self, "LoadGenUsagePlan",
            name="load-gen-api-plan",
            description="Usage plan for load generator API",
            throttle=apigateway.ThrottleSettings(
                rate_limit=100,
                burst_limit=200
            ),
            quota=apigateway.QuotaSettings(
                limit=10000,
                period=apigateway.Period.DAY
            )
        )

        usage_plan.add_api_stage(stage=api.deployment_stage)
        usage_plan.add_api_key(api_key)

        # Create start resource and method
        start_resource = api.root.add_resource("start")
        start_integration = apigateway.LambdaIntegration(
            start_lambda_function,
            proxy=True
        )
        
        start_resource.add_method(
            "POST",
            start_integration,
            api_key_required=True,
            method_responses=[
                apigateway.MethodResponse(
                    status_code="200",
                    response_parameters={
                        "method.response.header.Access-Control-Allow-Origin": True,
                        "method.response.header.Access-Control-Allow-Headers": True,
                        "method.response.header.Access-Control-Allow-Methods": True
                    }
                ),
                apigateway.MethodResponse(
                    status_code="500",
                    response_parameters={
                        "method.response.header.Access-Control-Allow-Origin": True,
                        "method.response.header.Access-Control-Allow-Headers": True,
                        "method.response.header.Access-Control-Allow-Methods": True
                    }
                )
            ]
        )

        # Create stop resource and method
        stop_resource = api.root.add_resource("stop")
        stop_integration = apigateway.LambdaIntegration(
            stop_lambda_function,
            proxy=True
        )
        
        stop_resource.add_method(
            "POST",
            stop_integration,
            api_key_required=True,
            method_responses=[
                apigateway.MethodResponse(
                    status_code="200",
                    response_parameters={
                        "method.response.header.Access-Control-Allow-Origin": True,
                        "method.response.header.Access-Control-Allow-Headers": True,
                        "method.response.header.Access-Control-Allow-Methods": True
                    }
                ),
                apigateway.MethodResponse(
                    status_code="500",
                    response_parameters={
                        "method.response.header.Access-Control-Allow-Origin": True,
                        "method.response.header.Access-Control-Allow-Headers": True,
                        "method.response.header.Access-Control-Allow-Methods": True
                    }
                )
            ]
        )

        # Outputs
        CfnOutput(self, "StartFunctionName", value=start_lambda_function.function_name)
        CfnOutput(self, "StopFunctionName", value=stop_lambda_function.function_name)
        CfnOutput(self, "ApiEndpoint", value=api.url)
        CfnOutput(self, "ApiKeyId", value=api_key.key_id)
        CfnOutput(self, "StartUrl", value=f"{api.url}start")
        CfnOutput(self, "StopUrl", value=f"{api.url}stop")

    def _build_lambda_package(self) -> str:
        """Build Lambda package with dependencies"""
        package_dir = "/tmp/lambda-package"
        
        # Clean and create package directory
        subprocess.run(["rm", "-rf", package_dir], check=True)
        subprocess.run(["mkdir", "-p", package_dir], check=True)
        
        # Check if required files exist
        lambda_file = os.path.join(os.path.dirname(__file__), "../lambda_loadgen_start.py")
        requirements_file = os.path.join(os.path.dirname(__file__), "../requirements.txt")
        
        files_exist = os.path.exists(lambda_file) and os.path.exists(requirements_file)
        is_destroy = self.node.try_get_context("target_url") == "dummy"
        
        if not files_exist and not is_destroy:
            raise FileNotFoundError("lambda_loadgen_start.py and requirements.txt are required for deploy operations")
        
        if files_exist:
            # Copy source files and install dependencies
            subprocess.run([
                "cp", "../lambda_loadgen_start.py", "../requirements.txt", package_dir
            ], cwd=os.path.dirname(__file__), check=True)
            
            subprocess.run([
                "pip", "install", "-r", "requirements.txt", "-t", "."
            ], cwd=package_dir, check=True)
        else:
            # Create dummy package for destroy operation
            with open(os.path.join(package_dir, "dummy.py"), "w") as f:
                f.write("# Dummy file for destroy operation\n")
        
        return package_dir

    def _build_stop_lambda_package(self) -> str:
        """Build stop Lambda package"""
        package_dir = "/tmp/lambda-stop-package"
        
        # Clean and create package directory
        subprocess.run(["rm", "-rf", package_dir], check=True)
        subprocess.run(["mkdir", "-p", package_dir], check=True)
        
        # Check if required files exist
        lambda_file = os.path.join(os.path.dirname(__file__), "../lambda_loadgen_stop.py")
        requirements_file = os.path.join(os.path.dirname(__file__), "../requirements.txt")
        is_destroy = self.node.try_get_context("target_url") == "dummy"
        
        if os.path.exists(lambda_file) and os.path.exists(requirements_file):
            # Copy source files and install dependencies
            subprocess.run([
                "cp", "../lambda_loadgen_stop.py", "../requirements.txt", package_dir
            ], cwd=os.path.dirname(__file__), check=True)
            
            subprocess.run([
                "pip", "install", "-r", "requirements.txt", "-t", "."
            ], cwd=package_dir, check=True)
        elif not is_destroy:
            raise FileNotFoundError("lambda_loadgen_stop.py and requirements.txt are required for deploy operations")
        else:
            # Create dummy package for destroy operation
            with open(os.path.join(package_dir, "dummy.py"), "w") as f:
                f.write("# Dummy file for destroy operation\n")
        
        return package_dir

    def _build_layer(self) -> str:
        """Build the kubectl/helm layer"""
        layer_dir = "/tmp/lambda-layer"
        
        # Run the build script
        result = subprocess.run(
            ["../build_lambda_layer.sh"],
            cwd=os.path.dirname(__file__),
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"Failed to build layer: {result.stderr}")
        
        # Extract the layer zip to a directory for CDK
        subprocess.run(["rm", "-rf", layer_dir], check=True)
        subprocess.run(["mkdir", "-p", layer_dir], check=True)
        subprocess.run(
            ["unzip", "-q", "./kubectl-helm-layer.zip", "-d", layer_dir],
            cwd=os.path.dirname(__file__),
            check=True
        )
        
        return layer_dir
