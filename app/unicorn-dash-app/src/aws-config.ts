import { Amplify } from 'aws-amplify';

Amplify.configure({
  // Add your AWS Amplify configuration here
  // This is just a placeholder - you'll need to replace with actual values
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
      signUpVerificationMethod: 'code',
      loginWith: {
        email: true,
        phone: false,
        username: true
      }
    }
  }
});