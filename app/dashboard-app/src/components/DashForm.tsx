import { useState, useEffect } from 'react';
import { fetchAuthSession } from '@aws-amplify/auth';

interface DashFormProps {
  onSocketChange?: (socket: WebSocket | null) => void;
}

export function DashForm({ onSocketChange }: DashFormProps) {
  const [positions, setPositions] = useState({ red: 0, blue: 0 });
  // Constants for the race visualization
  const totalDistance = 100; // Total distance to finish line
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    async function setupWebSocket() {
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        const ws = new WebSocket(`${import.meta.env.VITE_WEBSOCKET_URL}?ID_Token=${idToken}`);

        ws.onopen = async () => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('WebSocket connection established');
            // Request current position counts when connection is established
            try {
              const session = await fetchAuthSession();
              const username = session.tokens?.idToken?.payload['cognito:username'] || 'Anonymous';
              const payload = {
                message: 'sendmessage',
                messageType: 'getstate',
                username: username
              };
              ws.send(JSON.stringify(payload));
            } catch (error) {
              console.error('Error getting user session:', error);
            }
          } else {
            console.error('WebSocket is not open');
          }
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.messageType === 'red' || data.messageType === 'blue') {
            setPositions(prevPositions => ({
              ...prevPositions,
              [data.messageType]: data.count
            }));
          } else if (data.messageType === 'positionCounts') {
            // Handle the position counts response
            setPositions({
              red: data.red,
              blue: data.blue
            });
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
        };

        setSocket(ws);
        onSocketChange?.(ws);

        return () => {
          ws.close();
        };
      } catch (error) {
        console.error('Error setting up WebSocket:', error);
      }
    }

    setupWebSocket();
  }, [onSocketChange]);

  const handlePositionUpdate = async (messageType: 'red' | 'blue') => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        const session = await fetchAuthSession();
        const username = session.tokens?.idToken?.payload['cognito:username'] || 'Anonymous';
        const payload = {
          message: 'sendmessage',
          messageType: messageType,
          username: username
        };
        socket.send(JSON.stringify(payload));
      } catch (error) {
        console.error('Error getting user session:', error);
      }
    }
  };

  // Calculate position as percentage of total distance (use a maximum cap to prevent overflow)
  const maxPosition = Math.max(100, positions.red, positions.blue); // Cap at minimum of 100 highest position count
  const redPosition = (positions.red / maxPosition) * totalDistance;
  const bluePosition = (positions.blue / maxPosition) * totalDistance;

  // CSS styles for the race track and sliders
  const trackStyles = {
    width: '100%',
    height: '80px',
    backgroundColor: '#f0f0f0',
    position: 'relative' as const,
    borderRadius: '5px',
    margin: '30px 0',
    border: '2px solid #ccc'
  };

  const finishLineStyles = {
    position: 'absolute' as const,
    right: '0',
    top: '0',
    height: '100%',
    width: '5px',
    backgroundColor: '#3a3',
    zIndex: '1'
  };

  const sliderStyles = (color: string, position: number) => ({
    position: 'absolute' as const,
    left: `${position}%`,
    top: color === 'red' ? '5px' : '40px',
    width: '32px',
    height: '32px',
    backgroundImage: 'url("/src/assets/unicorn.png")',
    backgroundSize: 'cover',
    border: `2px solid ${color}`,
    borderRadius: '50%',
    transition: 'left 0.5s ease-in-out',
    zIndex: '2'
  });

  return (
    <div>
      <h2>Race Visualization</h2>
      <div style={trackStyles}>
        {/* Finish line */}
        <div style={finishLineStyles}></div>
        
        {/* Red slider */}
        <div style={sliderStyles('red', redPosition)}></div>
        
        {/* Blue slider */}
        <div style={sliderStyles('blue', bluePosition)}></div>
        
        {/* Labels showing position counts */}
        <div style={{ position: 'absolute', left: '10px', top: '-25px', color: 'red' }}>
          Red: {positions.red}
        </div>
        <div style={{ position: 'absolute', left: '10px', top: '80px', color: 'blue' }}>
          Blue: {positions.blue}
        </div>
      </div>

      <div className="move-buttons">
        <button 
          className="move-button red-button" 
          onClick={() => handlePositionUpdate('red')}
          style={{ backgroundColor: 'red', color: 'white', margin: '10px', padding: '15px 30px', borderRadius: '5px', fontSize: '16px' }}
        >
          Move Red
        </button>
        <button 
          className="move-button blue-button" 
          onClick={() => handlePositionUpdate('blue')}
          style={{ backgroundColor: 'blue', color: 'white', margin: '10px', padding: '15px 30px', borderRadius: '5px', fontSize: '16px' }}
        >
          Move Blue
        </button>
      </div>
    </div>
  );
}

export default DashForm;