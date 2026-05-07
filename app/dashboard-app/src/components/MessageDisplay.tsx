import { useState, useEffect } from 'react';
import { startLoadGenSingle, stopLoadGenSingle } from '../loadgen-api';
import EnvironmentMetrics from './EnvironmentMetrics';

interface MessageDisplayProps {
  socket: WebSocket | null;
}

let lastRaceCompletionTime: number | null = null;

enum RaceState {
  NotReady = 'not-ready',
  Pending = 'pending',
  Ready = 'ready',
  Running = 'running',
  Complete = 'complete'
}

enum RacePhase {
  Idle = 'idle',
  Heimdall = 'heimdall',
  NLB = 'nlb'
}

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

interface EnvironmentMetricsState {
  currentCount: number;
  totalBidRequests: number;
  prewarmBaseline: number;
  raceReport: RaceReport | null;
  prewarmComplete: boolean;
  raceComplete: boolean;
  error: string | null;
  isLoading: boolean;
  successMessage: string | null;
}

export function MessageDisplay({ socket }: MessageDisplayProps) {
  const [raceState, setRaceState] = useState<RaceState>(RaceState.NotReady);
  const [racePhase, setRacePhase] = useState<RacePhase>(RacePhase.Idle);
  const [metrics, setMetrics] = useState<{
    heimdall: EnvironmentMetricsState;
    nlb: EnvironmentMetricsState;
  }>({
    heimdall: {
      currentCount: 0,
      totalBidRequests: 0,
      prewarmBaseline: 0,
      raceReport: null,
      prewarmComplete: false,
      raceComplete: false,
      error: null,
      isLoading: false,
      successMessage: null
    },
    nlb: {
      currentCount: 0,
      totalBidRequests: 0,
      prewarmBaseline: 0,
      raceReport: null,
      prewarmComplete: false,
      raceComplete: false,
      error: null,
      isLoading: false,
      successMessage: null
    }
  });

  useEffect(() => {
    if (!socket || raceState === RaceState.NotReady) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const env = data.data?.['rtb-env'] || data['rtb-env'];

        if (!env || (env !== 'heimdall' && env !== 'nlb')) return;

        // LoadGen final report (has latencies, buckets, bytes_in, bytes_out, end)
        if (data.data?.latencies && data.data?.buckets && data.data?.bytes_in && data.data?.bytes_out && data.data?.end) {
          handleLoadGenReport(env, data);
          return;
        }

        // Metric-watcher message
        if (data.messageType === 'report' && data.data?.type === 'metrics' && data.data?.source === 'metric-watcher') {
          handleMetricWatcher(env, data);
        }
      } catch (e) {
        console.log('Failed to parse message:', e);
      }
    };

    const handleMetricWatcher = (env: 'heimdall' | 'nlb', data: any) => {
      let sum = 0;
      for (const [key, value] of Object.entries(data.data.metrics || {})) {
        if (key.startsWith('bidder_bid_request_received_number')) {
          sum += Number(value) || 0;
        }
      }

      setMetrics(prev => {
        const updated = { ...prev };
        updated[env] = { ...updated[env], totalBidRequests: sum };

        if (raceState === RaceState.Running) {
          const newCount = sum - updated[env].prewarmBaseline;
          updated[env].currentCount = newCount;
        }

        return updated;
      });
    };

    const handleLoadGenReport = async (env: 'heimdall' | 'nlb', data: any) => {
      const report: RaceReport = {
        earliest: data.data.earliest,
        latest: data.data.latest,
        end: data.data.end,
        duration: data.data.duration,
        wait: data.data.wait,
        requests: data.data.requests,
        throughput: data.data.throughput,
        success: data.data.success
      };

      if (raceState === RaceState.Pending) {
        // Prewarm complete
        setMetrics(prev => {
          const updated = { ...prev };
          updated[env] = { ...updated[env], prewarmComplete: true };
          return updated;
        });
        console.log('Prewarm complete, transitioning to Ready');
        setMetrics(prev => ({
          heimdall: { ...prev.heimdall, currentCount: 0, prewarmComplete: false },
          nlb: { ...prev.nlb, currentCount: 0, prewarmComplete: false }
        }));
        setRaceState(RaceState.Ready);
      } else if (raceState === RaceState.Running) {
        if (env === 'heimdall' && racePhase === RacePhase.Heimdall) {
          // Heimdall (Red) finished — store report, auto-start NLB (Blue)
          console.log('Heimdall race complete, auto-starting NLB');
          setMetrics(prev => ({
            ...prev,
            heimdall: { ...prev.heimdall, raceReport: report, raceComplete: true }
          }));
          setRacePhase(RacePhase.NLB);

          setMetrics(prev => ({
            ...prev,
            nlb: { ...prev.nlb, isLoading: true, error: null, prewarmBaseline: prev.nlb.totalBidRequests }
          }));
          const result = await startLoadGenSingle('nlb', {
            duration: '3m',
            devicesUsed: '1000'
          });
          setMetrics(prev => ({
            ...prev,
            nlb: {
              ...prev.nlb,
              isLoading: false,
              error: result.success ? null : `Start failed: ${result.error}`,
              successMessage: result.success ? 'Race started' : null
            }
          }));
          if (result.success) {
            setTimeout(() => {
              setMetrics(prev => ({ ...prev, nlb: { ...prev.nlb, successMessage: null } }));
            }, 3000);
          }
        } else if (env === 'nlb' && racePhase === RacePhase.NLB) {
          // NLB (Blue) finished — race complete
          console.log('NLB race complete, race finished');
          setMetrics(prev => ({
            ...prev,
            nlb: { ...prev.nlb, raceReport: report, raceComplete: true }
          }));
          lastRaceCompletionTime = Date.now();
          setRacePhase(RacePhase.Idle);
          setRaceState(RaceState.Complete);
        }
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => { socket.removeEventListener('message', handleMessage); };
  }, [socket, raceState, racePhase]);

  return (
    <div style={{ margin: '20px 0' }}>
      <h2>Race Control</h2>
      <span>State: <b>{raceState}</b></span>
      {racePhase !== RacePhase.Idle && (
        <span style={{
          marginLeft: '12px',
          padding: '4px 12px',
          borderRadius: '4px',
          backgroundColor: racePhase === RacePhase.Heimdall ? '#fef3c7' : '#dbeafe',
          color: racePhase === RacePhase.Heimdall ? '#92400e' : '#1e40af',
          fontWeight: 'bold',
          fontSize: '14px'
        }}>
          Racing: {racePhase === RacePhase.Heimdall ? 'Red (RTB Fabric)' : 'Blue (NLB)'}
        </span>
      )}

      <div className="control-buttons" style={{ marginTop: '10px' }}>
        {/* Prewarm: single call to warm the bidder pods */}
        <button
          disabled={raceState !== RaceState.NotReady}
          onClick={async () => {
            setMetrics(prev => ({
              heimdall: { ...prev.heimdall, currentCount: 0, isLoading: true, error: null },
              nlb: { ...prev.nlb, currentCount: 0, isLoading: true, error: null }
            }));
            setRaceState(RaceState.Pending);

            const result = await startLoadGenSingle('nlb', {
              duration: '10s',
              devicesUsed: '1'
            });

            setMetrics(prev => ({
              heimdall: { ...prev.heimdall, isLoading: false },
              nlb: {
                ...prev.nlb,
                isLoading: false,
                error: result.success ? null : `Prewarm failed: ${result.error}`,
                successMessage: result.success ? 'Prewarm started' : null
              }
            }));

            if (result.success) {
              setTimeout(() => {
                setMetrics(prev => ({ ...prev, nlb: { ...prev.nlb, successMessage: null } }));
              }, 3000);
            } else {
              console.error('Prewarm failed:', result.error);
            }
          }}
        >
          Prewarm
        </button>

        {/* Start: kicks off Heimdall first; NLB auto-starts when Heimdall report arrives */}
        <button
          disabled={raceState !== RaceState.Ready}
          onClick={async () => {
            setMetrics(prev => ({
              heimdall: {
                ...prev.heimdall,
                prewarmBaseline: prev.heimdall.totalBidRequests,
                currentCount: 0,
                isLoading: true,
                error: null,
                raceReport: null
              },
              nlb: {
                ...prev.nlb,
                prewarmBaseline: prev.nlb.totalBidRequests,
                currentCount: 0,
                isLoading: false,
                error: null,
                raceReport: null
              }
            }));
            setRaceState(RaceState.Running);
            setRacePhase(RacePhase.Heimdall);

            const result = await startLoadGenSingle('heimdall', {
              duration: '3m',
              devicesUsed: '1000'
            });

            setMetrics(prev => ({
              ...prev,
              heimdall: {
                ...prev.heimdall,
                isLoading: false,
                error: result.success ? null : `Start failed: ${result.error}`,
                successMessage: result.success ? 'Race started' : null
              }
            }));

            if (result.success) {
              setTimeout(() => {
                setMetrics(prev => ({ ...prev, heimdall: { ...prev.heimdall, successMessage: null } }));
              }, 3000);
            } else {
              console.error('Heimdall start failed:', result.error);
            }
          }}
        >
          Start
        </button>

        {/* Stop: stops whichever environment is currently racing */}
        <button
          disabled={raceState !== RaceState.Running}
          onClick={async () => {
            const activeEnv = racePhase === RacePhase.Heimdall ? 'heimdall' : 'nlb';
            setMetrics(prev => ({
              ...prev,
              [activeEnv]: { ...prev[activeEnv], isLoading: true, error: null }
            }));

            const result = await stopLoadGenSingle(activeEnv);

            setMetrics(prev => ({
              ...prev,
              [activeEnv]: {
                ...prev[activeEnv],
                isLoading: false,
                error: result.success ? null : `Stop failed: ${result.error}`,
                successMessage: result.success ? 'Race stopped' : null
              }
            }));

            if (result.success) {
              setTimeout(() => {
                setMetrics(prev => ({ ...prev, [activeEnv]: { ...prev[activeEnv], successMessage: null } }));
              }, 3000);
            }
          }}
        >
          Stop
        </button>

        {/* Reset */}
        <button
          disabled={raceState !== RaceState.Complete}
          onClick={() => {
            const now = Date.now();
            const tenMinutes = 10 * 60 * 1000;

            setRacePhase(RacePhase.Idle);

            if (lastRaceCompletionTime && (now - lastRaceCompletionTime) > tenMinutes) {
              setRaceState(RaceState.NotReady);
              setMetrics(prev => ({
                heimdall: { ...prev.heimdall, currentCount: 0, prewarmBaseline: 0, raceReport: null, raceComplete: false, error: null, isLoading: false, successMessage: null },
                nlb: { ...prev.nlb, currentCount: 0, prewarmBaseline: 0, raceReport: null, raceComplete: false, error: null, isLoading: false, successMessage: null }
              }));
              lastRaceCompletionTime = null;
            } else {
              setMetrics(prev => ({
                heimdall: { ...prev.heimdall, currentCount: 0, prewarmBaseline: prev.heimdall.totalBidRequests, raceReport: null, raceComplete: false },
                nlb: { ...prev.nlb, currentCount: 0, prewarmBaseline: prev.nlb.totalBidRequests, raceReport: null, raceComplete: false }
              }));
              setRaceState(RaceState.Ready);
            }
          }}
        >
          Reset
        </button>
      </div>

      <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
        <EnvironmentMetrics
          environment="heimdall"
          label="Red Car (RTB Fabric)"
          color="#dc2626"
          currentCount={metrics.heimdall.currentCount}
          totalBidRequests={metrics.heimdall.totalBidRequests}
          raceReport={metrics.heimdall.raceReport}
          error={metrics.heimdall.error}
          isLoading={metrics.heimdall.isLoading}
          successMessage={metrics.heimdall.successMessage}
        />
        <EnvironmentMetrics
          environment="nlb"
          label="Blue Car (NLB)"
          color="#2563eb"
          currentCount={metrics.nlb.currentCount}
          totalBidRequests={metrics.nlb.totalBidRequests}
          raceReport={metrics.nlb.raceReport}
          error={metrics.nlb.error}
          isLoading={metrics.nlb.isLoading}
          successMessage={metrics.nlb.successMessage}
        />
      </div>
    </div>
  );
}
