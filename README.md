# UnicornDash

A real-time dashboard application built with React and AWS serverless technologies, featuring WebSocket communication, Cognito authentication, and live data tracking.

## Project Overview

UnicornDash is a serverless web application that demonstrates:

- **Real-time Communication**: WebSocket API for live data updates
- **Authentication**: AWS Cognito user pool integration
- **Serverless Architecture**: Lambda functions for backend processing
- **Data Storage**: DynamoDB for connection mapping and tracking
- **Modern Frontend**: React with TypeScript and Vite

## Architecture

The application consists of two main components:

1. **Infrastructure** (`app/infrastructure/`): AWS SAM template defining serverless resources
2. **Frontend** (`app/unicorn-dash-app/`): React web application with real-time features

### AWS Resources

- **API Gateway WebSocket API**: Handles real-time connections
- **Lambda Functions**: OnConnect, OnDisconnect, SendMessage handlers
- **Lambda Authorizer**: Custom authentication for WebSocket connections
- **DynamoDB Tables**: Connection mapping and tracking data
- **Cognito User Pool**: User authentication and management

## Prerequisites

- AWS CLI configured with appropriate permissions
- AWS SAM CLI installed
- Node.js (v18 or later)
- npm or yarn package manager

## Deployment Instructions

### 1. Deploy SAM Infrastructure

Navigate to the infrastructure directory and deploy the stack:

```bash
cd app/infrastructure
sam build
sam deploy --guided
```

During the guided deployment, you can accept the default values or customize:
- Stack name: `unicorn-app`
- AWS Region: `us-east-1`
- ConnectionMappingTableName: `UnicornDashConnections`
- TrackingTableName: `UnicornDashTracking`

After successful deployment, note the output values:
- `WebSocketURI`: WebSocket endpoint URL
- `UserpoolId`: Cognito User Pool ID
- `ClientId`: Cognito User Pool Client ID

### 2. Configure the React Application

Configuration is handled through environment variables. Copy the example file and fill in the values from your SAM stack outputs:

```bash
cd app/unicorn-dash-app
cp .env.example .env
```

Edit `.env` with the values from your deployed stack:

```bash
VITE_WEBSOCKET_URL=wss://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/Prod/
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_HEIMDALL_API_URL=https://your-heimdall-api.execute-api.us-east-1.amazonaws.com/prod
VITE_HEIMDALL_API_KEY=your-heimdall-api-key
VITE_NLB_API_URL=https://your-nlb-api.execute-api.us-east-1.amazonaws.com/prod
VITE_NLB_API_KEY=your-nlb-api-key
```

You can retrieve the SAM stack outputs with:

```bash
aws cloudformation describe-stacks --stack-name unicorn-app --query 'Stacks[0].Outputs'
```

### 3. Build and Run the React Application

Navigate to the React app directory:

```bash
cd app/unicorn-dash-app
```

Install dependencies:

```bash
npm install
```

Build the application:

```bash
npm run build
```

For development, run the dev server:

```bash
npm run dev
```

The application will be available at `http://localhost:5173`

## Configuration Files

### SAM Configuration

The SAM configuration is defined in `app/infrastructure/samconfig.toml`:

```toml
version = 0.1
[default.deploy.parameters]
stack_name = "unicorn-app"
resolve_s3 = true
s3_prefix = "unircorn-app"
region = "us-east-1"
capabilities = "CAPABILITY_IAM"
parameter_overrides = "ConnectionMappingTableName=\"UnicornDashConnections\" TrackingTableName=\"UnicornDashTracking\""
```

### React App Configuration

Key configuration files:
- `.env` / `.env.example`: Environment variables for Cognito, WebSocket, and LoadGen API configuration
- `package.json`: Dependencies and build scripts
- `vite.config.ts`: Vite build configuration (includes `base: '/dash/'` for sub-path hosting)

## Development

### Local Development

1. Deploy the infrastructure first (required for backend services)
2. Copy `.env.example` to `.env` and fill in the SAM stack output values
3. Run the React development server: `npm run dev`

### Project Structure

```
UnicornDash/
├── app/
│   ├── infrastructure/          # AWS SAM infrastructure
│   │   ├── src/                # Lambda function source code
│   │   ├── template.yaml       # SAM template
│   │   └── samconfig.toml      # SAM configuration
│   └── unicorn-dash-app/       # React frontend application
│       ├── src/                # React source code
│       ├── public/             # Static assets
│       └── package.json        # Node.js dependencies
├── build_container.sh          # Container build script
├── run_container.sh           # Container run script
└── README.md                  # This file
```

## Scripts

### Infrastructure
- `sam build`: Build the SAM application
- `sam deploy`: Deploy to AWS
- `sam local start-api`: Run API locally (for testing)

### Frontend
- `npm run dev`: Start development server
- `npm run build`: Build for production
- `npm run preview`: Preview production build
- `npm run lint`: Run ESLint

## Troubleshooting

### Common Issues

1. **WebSocket Connection Failed**: Ensure `VITE_WEBSOCKET_URL` in `.env` is correct and the SAM stack is deployed
2. **Authentication Errors**: Verify `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID` in `.env` match the SAM stack outputs
3. **CORS Issues**: Check API Gateway CORS configuration if accessing from different domains

### Getting Stack Outputs

To retrieve the stack outputs after deployment:

```bash
aws cloudformation describe-stacks --stack-name unicorn-app --query 'Stacks[0].Outputs'
```

## License

This project is for demonstration purposes. Please refer to your organization's licensing requirements.