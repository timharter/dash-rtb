import os
import json
import base64
import logging
import jwt
import requests
import asyncio
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

class CognitoJwtVerifier:
    def __init__(self, user_pool_id: str, client_id: str, region: str):
        self.user_pool_id = user_pool_id
        self.client_id = client_id
        self.region = region
        
    async def validate_token(self, jwt_token: str):
        try:
            if not jwt_token:
                raise Exception("Missing identity bearer token")
            
            # Remove 'Bearer' prefix if present
            jwt_token = jwt_token.replace("Bearer", "").strip()
            
            # Get the JSON Web Key Set (JWKS) from Cognito
            issuer = f"https://cognito-idp.{self.region}.amazonaws.com/{self.user_pool_id}"
            jwks_url = f"{issuer}/.well-known/jwks.json"
            response = requests.get(jwks_url)
            jwks = response.json()["keys"][0]  # Get the first key from JWKS
            
            # Extract the public key components
            n = int.from_bytes(base64.urlsafe_b64decode(jwks["n"] + "=="), byteorder="big")
            e = int.from_bytes(base64.urlsafe_b64decode(jwks["e"] + "=="), byteorder="big")
            public_key = RSAPublicNumbers(e, n).public_key(backend=default_backend())
            
            # Decode and validate the token
            decoded = jwt.decode(
                jwt_token,
                key=public_key.public_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PublicFormat.SubjectPublicKeyInfo
                ),
                algorithms=["RS256"],
                audience=self.client_id,
                issuer=issuer,
                options={"verify_aud": True, "verify_iss": True}
            )
            
            return decoded
            
        except Exception as e:
            logger.error(f"Token validation error: {str(e)}")
            raise

def generate_policy(principal_id: str, effect: str, resource: str) -> Dict[str, Any]:
    return {
        "principalId": principal_id,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "execute-api:Invoke",
                    "Effect": effect,
                    "Resource": resource
                }
            ]
        }
    }

def generate_allow(principal_id: str, resource: str) -> Dict[str, Any]:
    return generate_policy(principal_id, "Allow", resource)

def generate_deny(principal_id: str, resource: str) -> Dict[str, Any]:
    return generate_policy(principal_id, "Deny", resource)

async def _lambda_handler(event, context):
    try:
        logger.info(f"Event received: {json.dumps(event)}")

        # Get environment variables
        user_pool_id = os.environ.get("COGNITO_USER_POOL_ID")
        client_id = os.environ.get("COGNITO_USER_POOL_CLIENT_ID")
        region = os.environ.get("AWS_REGION")
        
        if not all([user_pool_id, client_id, region]):
            raise ValueError("Missing required environment variables")
        
        # For API Gateway Lambda authorizers, the token is in the authorizationToken field
        token = event.get("authorizationToken")
        
        # If not found, try to get from query parameters as fallback
        if not token:
            query_params = event.get("queryStringParameters", {}) or {}
            token = query_params.get("ID_Token")
        
        if not token:
            logger.error("No authorization token found in request")
            raise ValueError("Missing authorization token")
            
        # Validate the token
        verifier = CognitoJwtVerifier(user_pool_id, client_id, region)
        claims = await verifier.validate_token(token)
        
        if claims:
            cognito_username = claims.get("cognito:username")
            return generate_allow(cognito_username, event["methodArn"])
            
        return generate_deny("default", event["methodArn"])
        
    except Exception as e:
        logger.error(f"Authorization error: {str(e)}")
        return generate_deny("default", event["methodArn"])

# This is the actual Lambda handler that AWS will call
def lambda_handler(event, context):
    return asyncio.run(_lambda_handler(event, context))
