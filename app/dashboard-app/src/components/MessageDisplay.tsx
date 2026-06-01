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
  RtbFabric = 'rtbfabric',
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
    rtbfabric: EnvironmentMetricsState;
    nlb: EnvironmentMetricsState;
  }>({
    rtbfabric: {
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

        if (!env || (env !== 'rtbfabric' && env !== 'nlb')) return;

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

    const handleMetricWatcher = (env: 'rtbfabric' | 'nlb', data: any) => {
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

    const handleLoadGenReport = async (env: 'rtbfabric' | 'nlb', data: any) => {
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
          rtbfabric: { ...prev.rtbfabric, currentCount: 0, prewarmComplete: false },
          nlb: { ...prev.nlb, currentCount: 0, prewarmComplete: false }
        }));
        setRaceState(RaceState.Ready);
      } else if (raceState === RaceState.Running) {
        if (env === 'rtbfabric' && racePhase === RacePhase.RtbFabric) {
          // RtbFabric (Red) finished — store report, auto-start NLB (Blue)
          console.log('RtbFabric race complete, auto-starting NLB');
          setMetrics(prev => ({
            ...prev,
            rtbfabric: { ...prev.rtbfabric, raceReport: report, raceComplete: true }
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
          backgroundColor: racePhase === RacePhase.RtbFabric ? '#fef3c7' : '#dbeafe',
          color: racePhase === RacePhase.RtbFabric ? '#92400e' : '#1e40af',
          fontWeight: 'bold',
          fontSize: '14px'
        }}>
          Racing: {racePhase === RacePhase.RtbFabric ? 'Red (RTB Fabric)' : 'Blue (NLB)'}
        </span>
      )}

      <div className="control-buttons" style={{ marginTop: '10px' }}>
        {/* Prewarm: single call to warm the bidder pods */}
        <button
          disabled={raceState !== RaceState.NotReady}
          onClick={async () => {
            setMetrics(prev => ({
              rtbfabric: { ...prev.rtbfabric, currentCount: 0, isLoading: true, error: null },
              nlb: { ...prev.nlb, currentCount: 0, isLoading: true, error: null }
            }));
            setRaceState(RaceState.Pending);

            const result = await startLoadGenSingle('nlb', {
              duration: '10s',
              devicesUsed: '1'
            });

            setMetrics(prev => ({
              rtbfabric: { ...prev.rtbfabric, isLoading: false },
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
              // Transition to ready after prewarm duration + buffer.
              // The LoadGen report via WebSocket is unreliable when the bidder
              // is not yet running — fall back to a fixed timeout.
              setTimeout(() => {
                setRaceState(prev => prev === RaceState.Pending ? RaceState.Ready : prev);
              }, 20000);
            } else {
              console.error('Prewarm failed:', result.error);
            }
          }}
        >
          Prewarm
        </button>

        {/* Start: kicks off RtbFabric first; NLB auto-starts when RtbFabric report arrives */}
        <button
          disabled={raceState !== RaceState.Ready}
          onClick={async () => {
            setMetrics(prev => ({
              rtbfabric: {
                ...prev.rtbfabric,
                prewarmBaseline: prev.rtbfabric.totalBidRequests,
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
            setRacePhase(RacePhase.RtbFabric);

            const result = await startLoadGenSingle('rtbfabric', {
              duration: '3m',
              devicesUsed: '1000'
            });

            setMetrics(prev => ({
              ...prev,
              rtbfabric: {
                ...prev.rtbfabric,
                isLoading: false,
                error: result.success ? null : `Start failed: ${result.error}`,
                successMessage: result.success ? 'Race started' : null
              }
            }));

            if (result.success) {
              setTimeout(() => {
                setMetrics(prev => ({ ...prev, rtbfabric: { ...prev.rtbfabric, successMessage: null } }));
              }, 3000);
            } else {
              console.error('RtbFabric start failed:', result.error);
            }
          }}
        >
          Start
        </button>

        {/* Stop: stops whichever environment is currently racing */}
        <button
          disabled={raceState !== RaceState.Running}
          onClick={async () => {
            const activeEnv = racePhase === RacePhase.RtbFabric ? 'rtbfabric' : 'nlb';
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
                rtbfabric: { ...prev.rtbfabric, currentCount: 0, prewarmBaseline: 0, raceReport: null, raceComplete: false, error: null, isLoading: false, successMessage: null },
                nlb: { ...prev.nlb, currentCount: 0, prewarmBaseline: 0, raceReport: null, raceComplete: false, error: null, isLoading: false, successMessage: null }
              }));
              lastRaceCompletionTime = null;
            } else {
              setMetrics(prev => ({
                rtbfabric: { ...prev.rtbfabric, currentCount: 0, prewarmBaseline: prev.rtbfabric.totalBidRequests, raceReport: null, raceComplete: false },
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
          environment="rtbfabric"
          label="Red Car (RTB Fabric)"
          color="#dc2626"
          currentCount={metrics.rtbfabric.currentCount}
          totalBidRequests={metrics.rtbfabric.totalBidRequests}
          raceReport={metrics.rtbfabric.raceReport}
          error={metrics.rtbfabric.error}
          isLoading={metrics.rtbfabric.isLoading}
          successMessage={metrics.rtbfabric.successMessage}
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
