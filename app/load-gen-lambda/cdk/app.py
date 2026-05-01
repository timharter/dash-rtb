#!/usr/bin/env python3
import aws_cdk as cdk
from lambda_helm_stack import LambdaHelmStack

app = cdk.App()

# Get context values
target_nlb = app.node.try_get_context("target_nlb")
target_heimdall = app.node.try_get_context("target_heimdall")
ecr_repository_name = app.node.try_get_context("ecr_repository_name")
cluster_name = app.node.try_get_context("cluster_name")
region = app.node.try_get_context("region") or "us-east-1"

if not target_nlb or not target_heimdall or not ecr_repository_name:
    raise ValueError("target_nlb, target_heimdall, and ecr_repository_name are required context values")

LambdaHelmStack(
    app, 
    "LambdaHelmStack",
    target_nlb=target_nlb,
    target_heimdall=target_heimdall,
    ecr_repository_name=ecr_repository_name,
    cluster_name=cluster_name,
    env=cdk.Environment(region=region)
)

app.synth()
