import { useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { DashForm } from './DashForm';
import { MessageDisplay } from './MessageDisplay';

export function LoginForm() {
  const [socket, setSocket] = useState<WebSocket | null>(null);

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <div>
          {user ? (
            <div>
              <h2>Welcome, {user.username}!</h2>
              <DashForm onSocketChange={setSocket} />
              <MessageDisplay socket={socket} />
              <button onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <h2>Please sign in</h2>
          )}
        </div>
      )}
    </Authenticator>
  );
}

export default LoginForm;