FROM amazonlinux:2023

# Update system packages
RUN dnf update -y && \
    dnf install -y \
    jq \
    git \
    tar \
    zip \
    gzip \
    unzip \
    openssl \
    python3 \
    python3-pip \
    libicu \
    zlib-devel \
    krb5-devel

# Install Node.js 18 using NodeSource repository
RUN curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - && \
    dnf install -y nodejs

# Install AWS CLI v2 - with architecture detection
RUN architecture=$(uname -m) && \
    if [ "${architecture}" = "aarch64" ]; then \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip

# Install AWS SAM CLI
RUN architecture=$(uname -m) && \
    if [ "${architecture}" = "aarch64" ]; then \
        curl -L "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-arm64.zip" -o "aws-sam-cli.zip"; \
    else \
        curl -L "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip" -o "aws-sam-cli.zip"; \
    fi && \
    unzip aws-sam-cli.zip -d sam-installation && \
    ./sam-installation/install && \
    rm -rf sam-installation aws-sam-cli.zip

# Install AWS Amplify CLI
RUN npm install -g @aws-amplify/cli
RUN npm install -g aws-cdk

# Install .NET Core CLI
RUN curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --version latest && \
    echo 'export DOTNET_ROOT=$HOME/.dotnet' >> /root/.bashrc && \
    echo 'export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools' >> /root/.bashrc && \
    source /root/.bashrc && \
    ln -s $HOME/.dotnet/dotnet /usr/local/bin/dotnet && \
    dotnet tool install -g Amazon.Lambda.Tools && \
    dotnet --list-sdks

# Verify installations
RUN node --version && \
    npm --version && \
    aws --version && \
    amplify --version && \
    sam --version && \
    dotnet --help

# Set working directory
WORKDIR /app

CMD ["/bin/bash"]