interface RaceReport {
  earliest: string;
  latest: string;
  end: string;
  duration: number;
  wait: number;
  requests: number;
  throughput: number;
  success: number;
}

interface EnvironmentMetricsProps {
  environment: 'heimdall' | 'nlb';
  label: string;
  color: string;
  currentCount: number;
  totalBidRequests: number;
  raceReport: RaceReport | null;
  error: string | null;
  isLoading: boolean;
  successMessage: string | null;
}

export default function EnvironmentMetrics({
  label,
  color,
  currentCount,
  totalBidRequests,
  raceReport,
  error,
  isLoading,
  successMessage
}: EnvironmentMetricsProps) {
  // Determine border color based on state
  const borderColor = error ? '#dc2626' : isLoading ? '#f59e0b' : successMessage ? '#16a34a' : color;
  const backgroundColor = error ? '#fef2f2' : isLoading ? '#fffbeb' : successMessage ? '#f0fdf4' : '#f9f9f9';
  
  return (
    <div 
      style={{
        border: `3px solid ${borderColor}`,
        borderRadius: '8px',
        padding: '20px',
        backgroundColor,
        minWidth: '300px',
        position: 'relative'
      }}
    >
      <h2 style={{ color, marginTop: 0 }}>{label}</h2>
      
      {/* Status indicator */}
      {isLoading && (
        <div style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          padding: '4px 12px',
          backgroundColor: '#f59e0b',
          color: 'white',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 'bold'
        }}>
          LOADING...
        </div>
      )}
      
      {error && (
        <div style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          padding: '4px 12px',
          backgroundColor: '#dc2626',
          color: 'white',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 'bold'
        }}>
          ERROR
        </div>
      )}
      
      {successMessage && !error && !isLoading && (
        <div style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          padding: '4px 12px',
          backgroundColor: '#16a34a',
          color: 'white',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 'bold'
        }}>
          ✓ SUCCESS
        </div>
      )}
      
      {/* Error message display */}
      {error && (
        <div style={{
          marginBottom: '15px',
          padding: '10px',
          backgroundColor: '#fee2e2',
          border: '1px solid #dc2626',
          borderRadius: '4px',
          color: '#991b1b',
          fontSize: '14px'
        }}>
          <strong>{label} Error:</strong> {error}
        </div>
      )}
      
      <div style={{ marginBottom: '15px' }}>
        <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
          Current Count
        </div>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
          {currentCount.toLocaleString()}
        </div>
      </div>

      <div style={{ marginBottom: '15px' }}>
        <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
          Total Bid Requests
        </div>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
          {totalBidRequests.toLocaleString()}
        </div>
      </div>

      <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #ddd' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Race Results</h3>
        {raceReport ? (
          <div style={{ fontSize: '14px' }}>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Earliest:</span> {raceReport.earliest}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Latest:</span> {raceReport.latest}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>End:</span> {raceReport.end}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Duration:</span> {(raceReport.duration / 1000000000).toFixed(2)}s
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Wait:</span> {(raceReport.wait / 1000000).toFixed(2)}ms
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Requests:</span> {raceReport.requests.toLocaleString()}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Throughput:</span> {raceReport.throughput.toFixed(2)} req/s
            </div>
            <div style={{ marginBottom: '8px' }}>
              <span style={{ color: '#666' }}>Success:</span> {(raceReport.success * 100).toFixed(2)}%
            </div>
          </div>
        ) : (
          <div style={{ color: '#999', fontStyle: 'italic' }}>
            No race results available
          </div>
        )}
      </div>
    </div>
  );
}
