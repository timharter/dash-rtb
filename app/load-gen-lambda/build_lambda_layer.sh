#!/bin/bash

# Script to build Lambda layer with kubectl and helm binaries
# This creates a layer that can be used with the Lambda function

set -e

echo "Building Lambda layer with kubectl and helm..."

# Create temporary directory for layer
LAYER_DIR="lambda-layer"
rm -rf $LAYER_DIR
mkdir -p $LAYER_DIR/bin

cd $LAYER_DIR

echo "Downloading kubectl for Linux ARM64..."
# Download kubectl for Linux ARM64 (Lambda runtime is ARM64)
KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt)
curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/arm64/kubectl"
chmod +x kubectl

# Verify kubectl binary
echo "Verifying kubectl binary..."
file kubectl
if file kubectl | grep -q "aarch64"; then
    echo "✅ kubectl binary is correct architecture (ARM64)"
else
    echo "❌ kubectl binary architecture mismatch"
    file kubectl
    exit 1
fi

mv kubectl bin/

echo "Downloading helm for Linux ARM64..."
# Download helm for Linux ARM64
HELM_VERSION=$(curl -s https://api.github.com/repos/helm/helm/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
echo "Latest Helm version: $HELM_VERSION"

curl -LO "https://get.helm.sh/helm-${HELM_VERSION}-linux-arm64.tar.gz"
tar -zxvf "helm-${HELM_VERSION}-linux-arm64.tar.gz"

# Verify helm binary
echo "Verifying helm binary..."
file linux-arm64/helm
if file linux-arm64/helm | grep -q "aarch64"; then
    echo "✅ helm binary is correct architecture (ARM64)"
else
    echo "❌ helm binary architecture mismatch"
    file linux-arm64/helm
    exit 1
fi

mv linux-arm64/helm bin/
chmod +x bin/helm

# Clean up
rm -rf linux-arm64 "helm-${HELM_VERSION}-linux-arm64.tar.gz"

echo "Creating layer zip..."
zip -r ../kubectl-helm-layer.zip bin/

cd ..

echo "Lambda layer created: kubectl-helm-layer.zip"
echo "Layer contents:"
unzip -l kubectl-helm-layer.zip

echo ""
echo "Verifying binaries in the zip:"
unzip -j kubectl-helm-layer.zip bin/kubectl bin/helm -d temp-verify/
echo "kubectl info:"
file temp-verify/kubectl
echo "helm info:"
file temp-verify/helm
rm -rf temp-verify/

echo ""
echo "To deploy this layer to AWS Lambda:"
echo "aws lambda publish-layer-version \\"
echo "    --layer-name kubectl-helm-layer \\"
echo "    --description 'kubectl and helm binaries for Lambda' \\"
echo "    --zip-file fileb://kubectl-helm-layer.zip \\"
echo "    --compatible-runtimes python3.9 python3.10 python3.11"

# Clean up
rm -rf $LAYER_DIR

echo "Build complete!"
