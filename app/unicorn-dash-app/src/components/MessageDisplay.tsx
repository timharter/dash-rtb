import { useState, useEffect } from 'react';
import { startLoadGenDual, stopLoadGenDual, startLoadGenSingle, stopLoadGenSingle } from '../loadgen-api';
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

export enum ExecutionMode {
  Parallel = 'parallel',
  Sequential = 'sequential'
}

export enum SequentialPhase {
  Idle = 'idle',
  RunningFirst = 'running-first',
  RunningSecond = 'running-second'
}

export function MessageDisplay({ socket }: MessageDisplayProps) {
  const [raceState, setRaceState] = useState<RaceState>(RaceState.NotReady);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(ExecutionMode.Parallel);
  const [sequentialPhase, setSequentialPhase] = useState<SequentialPhase>(SequentialPhase.Idle);
  const [firstEnvironment, setFirstEnvironment] = useState<'heimdall' | 'nlb'>('heimdall');
  const [sequentialError, setSequentialError] = useState<{ env: string; message: string } | null>(null);
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
      const timestamp = new Date().toLocaleTimeString();
      
      console.log('Received message:', `[${timestamp}] ${event.data}`);
      
      try {
        const data = JSON.parse(event.data);
        console.log('Parsed data:', data);
        
        // Extract rtb-env field from message
        const env = data.data?.['rtb-env'] || data['rtb-env'];
        
        // Validate rtb-env
        if (!env || (env !== 'heimdall' && env !== 'nlb')) {
          console.warn('Missing or invalid rtb-env:', env, 'in message:', data);
          return;
        }
        
        console.log('Environment:', env);
        
        // Check for LoadGen final report
        if (data.data?.latencies && data.data?.buckets && data.data?.bytes_in && data.data?.bytes_out && data.data?.end) {
          console.log('LoadGen final report received for', env);
          handleLoadGenReport(env, data);
          return;
        }
        
        // Check for metric-watcher message
        if (data.messageType === 'report' && data.data?.type === 'metrics' && data.data?.source === 'metric-watcher') {
          console.log('Metric-watcher message received for', env);
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
      console.log(`${env} total sum:`, sum);
      
      setMetrics(prev => {
        const updated = { ...prev };
        updated[env] = { ...updated[env], totalBidRequests: sum };
        
        // Update currentCount only if in Running state
        if (raceState === RaceState.Running) {
          const newCount = sum - updated[env].prewarmBaseline;
          console.log(`${env} Running: total=${sum}, baseline=${updated[env].prewarmBaseline}, current=${newCount}`);
          updated[env].currentCount = newCount;
        }
        
        return updated;
      });
    };

    const handleLoadGenReport = (env: 'heimdall' | 'nlb', data: any) => {
      if (raceState === RaceState.Pending) {
        // Mark prewarm complete for this environment
        setMetrics(prev => {
          const updated = { ...prev };
          updated[env] = { ...updated[env], prewarmComplete: true };
          
          // Check if both environments completed prewarm
          if (updated.heimdall.prewarmComplete && updated.nlb.prewarmComplete) {
            console.log('Both environments prewarm complete, transitioning to Ready');
            // Set currentCount to 0 for both
            updated.heimdall.currentCount = 0;
            updated.nlb.currentCount = 0;
            // Reset prewarmComplete flags for next race
            updated.heimdall.prewarmComplete = false;
            updated.nlb.prewarmComplete = false;
            setRaceState(RaceState.Ready);
          }
          
          return updated;
        });
      } else if (raceState === RaceState.Running) {
        // Store race report for this environment
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
        
        if (executionMode === ExecutionMode.Sequential) {
          const secondEnv: 'heimdall' | 'nlb' = firstEnvironment === 'heimdall' ? 'nlb' : 'heimdall';
          
          if (env === firstEnvironment && sequentialPhase === SequentialPhase.RunningFirst) {
            // First env completed, store report and auto-start second
            console.log(`Sequential: ${firstEnvironment} complete, auto-starting ${secondEnv}`);
            setMetrics(prev => {
              const updated = { ...prev };
              updated[env] = { ...updated[env], raceReport: report, raceComplete: true };
              return updated;
            });
            setSequentialPhase(SequentialPhase.RunningSecond);
            
            // Auto-start second environment
            setMetrics(prev => ({
              ...prev,
              [secondEnv]: { ...prev[secondEnv], isLoading: true, error: null }
            }));
            const result = await startLoadGenSingle(secondEnv, {
              duration: '3m',
              devicesUsed: '1000'
            });
            setMetrics(prev => ({
              ...prev,
              [secondEnv]: {
                ...prev[secondEnv],
                isLoading: false,
                error: result.success ? null : `Start failed: ${result.error}`,
                successMessage: result.success ? 'Race started' : null
              }
            }));
            if (result.success) {
              console.log(`Sequential: ${secondEnv} started successfully`);
              setTimeout(() => {
                setMetrics(prev => ({
                  ...prev,
                  [secondEnv]: { ...prev[secondEnv], successMessage: null }
                }));
              }, 3000);
            } else {
              console.error(`Sequential: ${secondEnv} start failed:`, result.error);
            }
          } else if (env === secondEnv && sequentialPhase === SequentialPhase.RunningSecond) {
            // Second env completed, race is done
            console.log('Sequential: both environments complete, transitioning to Complete');
            setMetrics(prev => {
              const updated = { ...prev };
              updated[env] = { ...updated[env], raceReport: report, raceComplete: true };
              // Reset raceComplete flags
              updated.heimdall.raceComplete = false;
              updated.nlb.raceComplete = false;
              return updated;
            });
            lastRaceCompletionTime = Date.now();
            setSequentialPhase(SequentialPhase.Idle);
            setRaceState(RaceState.Complete);
          }
        } else {
          // Parallel mode: existing behavior
          setMetrics(prev => {
            const updated = { ...prev };
            updated[env] = { ...updated[env], raceReport: report, raceComplete: true };
            
            // Check if both environments completed race
            if (updated.heimdall.raceComplete && updated.nlb.raceComplete) {
              console.log('Both environments race complete, transitioning to Complete');
              lastRaceCompletionTime = Date.now();
              // Reset raceComplete flags for next race
              updated.heimdall.raceComplete = false;
              updated.nlb.raceComplete = false;
              setRaceState(RaceState.Complete);
            }
            
            return updated;
          });
        }
      }
    };

    socket.addEventListener('message', handleMessage);

    return () => {
      socket.removeEventListener('message', handleMessage);
    };
  }, [socket, raceState, executionMode, sequentialPhase, firstEnvironment]);

  return (
    <div style={{ margin: '20px 0' }}>
      <h2>Race Control</h2>
      <span>State: <b>{raceState}</b></span>
      
      {/* Execution Mode Toggle */}
      <div style={{ margin: '10px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <label>
          <span style={{ marginRight: '8px' }}>Mode:</span>
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
            disabled={raceState !== RaceState.NotReady}
            style={{ padding: '4px 8px' }}
          >
            <option value={ExecutionMode.Parallel}>Parallel</option>
            <option value={ExecutionMode.Sequential}>Sequential</option>
          </select>
        </label>
        {executionMode === ExecutionMode.Sequential && (
          <label>
            <span style={{ marginRight: '8px' }}>First:</span>
            <select
              value={firstEnvironment}
              onChange={(e) => setFirstEnvironment(e.target.value as 'heimdall' | 'nlb')}
              disabled={raceState !== RaceState.NotReady}
              style={{ padding: '4px 8px' }}
            >
              <option value="heimdall">Heimdall</option>
              <option value="nlb">NLB</option>
            </select>
          </label>
        )}
        {executionMode === ExecutionMode.Sequential && sequentialPhase !== SequentialPhase.Idle && (
          <span style={{ 
            padding: '4px 12px', 
            borderRadius: '4px', 
            backgroundColor: sequentialPhase === SequentialPhase.RunningFirst ? '#fef3c7' : '#dbeafe',
            color: sequentialPhase === SequentialPhase.RunningFirst ? '#92400e' : '#1e40af',
            fontWeight: 'bold',
            fontSize: '14px'
          }}>
            {sequentialPhase === SequentialPhase.RunningFirst 
              ? `Running: ${firstEnvironment === 'heimdall' ? 'Heimdall' : 'NLB'} (1st)` 
              : `Running: ${firstEnvironment === 'heimdall' ? 'NLB' : 'Heimdall'} (2nd)`}
          </span>
        )}
      </div>
      <div className="control-buttons">
        <button 
          disabled={raceState !== RaceState.NotReady}
          onClick={async () => {
            // Set currentCount to 0 and loading state for both environments
            setMetrics(prev => ({
              heimdall: { ...prev.heimdall, currentCount: 0, isLoading: true, error: null },
              nlb: { ...prev.nlb, currentCount: 0, isLoading: true, error: null }
            }));
            setRaceState(RaceState.Pending);
            
            const results = await startLoadGenDual({ 
              duration: '10s', 
              devicesUsed: '1' 
            });
            
            // Update error states and show success
            setMetrics(prev => ({
              heimdall: {
                ...prev.heimdall,
                isLoading: false,
                error: results.heimdall.success ? null : `Prewarm failed: ${results.heimdall.error}`,
                successMessage: results.heimdall.success ? 'Prewarm started' : null
              },
              nlb: {
                ...prev.nlb,
                isLoading: false,
                error: results.nlb.success ? null : `Prewarm failed: ${results.nlb.error}`,
                successMessage: results.nlb.success ? 'Prewarm started' : null
              }
            }));
            
            // Clear success messages after 3 seconds
            if (results.heimdall.success || results.nlb.success) {
              setTimeout(() => {
                setMetrics(prev => ({
                  heimdall: { ...prev.heimdall, successMessage: null },
                  nlb: { ...prev.nlb, successMessage: null }
                }));
              }, 3000);
            }
            
            if (!results.heimdall.success) {
              console.error("Heimdall prewarm failed:", results.heimdall.error);
            }
            if (!results.nlb.success) {
              console.error("NLB prewarm failed:", results.nlb.error);
            }
            if (results.heimdall.success && results.nlb.success) {
              console.log("Prewarm started successfully for both environments");
            }
          }}
        >
          Prewarm
        </button>
        <button 
          disabled={raceState !== RaceState.Ready}
          onClick={async () => {
            // Capture current totalBidRequests as prewarmBaseline and set loading state
            setMetrics(prev => ({
              heimdall: { 
                ...prev.heimdall, 
                prewarmBaseline: prev.heimdall.totalBidRequests,
                isLoading: true,
                error: null
              },
              nlb: { 
                ...prev.nlb, 
                prewarmBaseline: prev.nlb.totalBidRequests,
                isLoading: true,
                error: null
              }
            }));
            console.log('Race started - baselines set to:', {
              heimdall: metrics.heimdall.totalBidRequests,
              nlb: metrics.nlb.totalBidRequests
            });
            setRaceState(RaceState.Running);
            setSequentialError(null);
            
            if (executionMode === ExecutionMode.Sequential) {
              // Sequential mode: start only the first environment
              setSequentialPhase(SequentialPhase.RunningFirst);
              const result = await startLoadGenSingle(firstEnvironment, {
                duration: '3m',
                devicesUsed: '1000'
              });
              
              setMetrics(prev => ({
                ...prev,
                [firstEnvironment]: {
                  ...prev[firstEnvironment],
                  isLoading: false,
                  error: result.success ? null : `Start failed: ${result.error}`,
                  successMessage: result.success ? 'Race started' : null
                },
                [firstEnvironment === 'heimdall' ? 'nlb' : 'heimdall']: {
                  ...prev[firstEnvironment === 'heimdall' ? 'nlb' : 'heimdall'],
                  isLoading: false
                }
              }));
              
              if (!result.success) {
                console.error(`${firstEnvironment} start failed:`, result.error);
                setSequentialError({ env: firstEnvironment, message: result.error || 'Unknown error' });
              } else {
                console.log(`Sequential mode: ${firstEnvironment} started successfully`);
                // Clear success message after 3 seconds
                setTimeout(() => {
                  setMetrics(prev => ({
                    ...prev,
                    [firstEnvironment]: { ...prev[firstEnvironment], successMessage: null }
                  }));
                }, 3000);
              }
            } else {
              // Parallel mode: existing behavior
              const results = await startLoadGenDual({
                duration: '3m', 
                devicesUsed: '1000'
              });
              
              // Update error states and show success
              setMetrics(prev => ({
                heimdall: {
                  ...prev.heimdall,
                  isLoading: false,
                  error: results.heimdall.success ? null : `Start failed: ${results.heimdall.error}`,
                  successMessage: results.heimdall.success ? 'Race started' : null
                },
                nlb: {
                  ...prev.nlb,
                  isLoading: false,
                  error: results.nlb.success ? null : `Start failed: ${results.nlb.error}`,
                  successMessage: results.nlb.success ? 'Race started' : null
                }
              }));
              
              // Clear success messages after 3 seconds
              if (results.heimdall.success || results.nlb.success) {
                setTimeout(() => {
                  setMetrics(prev => ({
                    heimdall: { ...prev.heimdall, successMessage: null },
                    nlb: { ...prev.nlb, successMessage: null }
                  }));
                }, 3000);
              }
              
              if (!results.heimdall.success) {
                console.error("Heimdall start failed:", results.heimdall.error);
              }
              if (!results.nlb.success) {
                console.error("NLB start failed:", results.nlb.error);
              }
              if (results.heimdall.success && results.nlb.success) {
                console.log("LoadGen started successfully for both environments");
              }
            }
          }}
        >
          Start
        </button>
        <button 
          disabled={raceState !== RaceState.Running}
          onClick={async () => {
            // Set loading state
            setMetrics(prev => ({
              heimdall: { ...prev.heimdall, isLoading: true, error: null },
              nlb: { ...prev.nlb, isLoading: true, error: null }
            }));
            
            if (executionMode === ExecutionMode.Sequential) {
              // Sequential mode: stop only the currently active environment
              const activeEnv: 'heimdall' | 'nlb' = sequentialPhase === SequentialPhase.RunningFirst 
                ? firstEnvironment 
                : (firstEnvironment === 'heimdall' ? 'nlb' : 'heimdall');
              
              const result = await stopLoadGenSingle(activeEnv);
              
              setMetrics(prev => ({
                ...prev,
                heimdall: { ...prev.heimdall, isLoading: false },
                nlb: { ...prev.nlb, isLoading: false },
                [activeEnv]: {
                  ...prev[activeEnv],
                  isLoading: false,
                  error: result.success ? null : `Stop failed: ${result.error}`,
                  successMessage: result.success ? 'Race stopped' : null
                }
              }));
              
              if (result.success) {
                console.log(`Sequential: ${activeEnv} stopped successfully`);
                setTimeout(() => {
                  setMetrics(prev => ({
                    ...prev,
                    [activeEnv]: { ...prev[activeEnv], successMessage: null }
                  }));
                }, 3000);
              } else {
                console.error(`Sequential: ${activeEnv} stop failed:`, result.error);
              }
            } else {
              // Parallel mode: existing behavior
              const results = await stopLoadGenDual();
              
              // Update error states and show success
              setMetrics(prev => ({
                heimdall: {
                  ...prev.heimdall,
                  isLoading: false,
                  error: results.heimdall.success ? null : `Stop failed: ${results.heimdall.error}`,
                  successMessage: results.heimdall.success ? 'Race stopped' : null
                },
                nlb: {
                  ...prev.nlb,
                  isLoading: false,
                  error: results.nlb.success ? null : `Stop failed: ${results.nlb.error}`,
                  successMessage: results.nlb.success ? 'Race stopped' : null
                }
              }));
              
              // Clear success messages after 3 seconds
              if (results.heimdall.success || results.nlb.success) {
                setTimeout(() => {
                  setMetrics(prev => ({
                    heimdall: { ...prev.heimdall, successMessage: null },
                    nlb: { ...prev.nlb, successMessage: null }
                  }));
                }, 3000);
              }
              
              if (!results.heimdall.success) {
                console.error("Heimdall stop failed:", results.heimdall.error);
              }
              if (!results.nlb.success) {
                console.error("NLB stop failed:", results.nlb.error);
              }
              if (results.heimdall.success && results.nlb.success) {
                console.log("LoadGen stopped successfully for both environments");
              }
            }
          }}
        >
          Stop
        </button>
        <button 
          disabled={raceState !== RaceState.Complete}
          onClick={() => {
            const now = Date.now();
            const tenMinutes = 10 * 60 * 1000;
            
            setSequentialPhase(SequentialPhase.Idle);
            setSequentialError(null);
            
            // Check if over 10 minutes since last race completion
            if (lastRaceCompletionTime && (now - lastRaceCompletionTime) > tenMinutes) {
              // Over 10 min: reset to initial state, require prewarm
              setRaceState(RaceState.NotReady);
              setMetrics({
                heimdall: {
                  currentCount: 0,
                  totalBidRequests: metrics.heimdall.totalBidRequests,
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
                  totalBidRequests: metrics.nlb.totalBidRequests,
                  prewarmBaseline: 0,
                  raceReport: null,
                  prewarmComplete: false,
                  raceComplete: false,
                  error: null,
                  isLoading: false,
                  successMessage: null
                }
              });
              lastRaceCompletionTime = null;
            } else {
              // Under 10 min: quick reset, update baseline and go to ready state
              setMetrics(prev => ({
                heimdall: {
                  ...prev.heimdall,
                  currentCount: 0,
                  prewarmBaseline: prev.heimdall.totalBidRequests,
                  raceReport: null
                },
                nlb: {
                  ...prev.nlb,
                  currentCount: 0,
                  prewarmBaseline: prev.nlb.totalBidRequests,
                  raceReport: null
                }
              }));
              setRaceState(RaceState.Ready);
            }
          }}
        >
          Reset
        </button>
      </div>

      {/* Sequential mode error with Retry/Skip */}
      {sequentialError && executionMode === ExecutionMode.Sequential && sequentialPhase === SequentialPhase.RunningFirst && (
        <div style={{ 
          margin: '10px 0', 
          padding: '12px', 
          backgroundColor: '#fef2f2', 
          border: '1px solid #fecaca', 
          borderRadius: '6px' 
        }}>
          <p style={{ color: '#991b1b', margin: '0 0 8px 0', fontWeight: 'bold' }}>
            {sequentialError.env === 'heimdall' ? 'Heimdall' : 'NLB'} failed: {sequentialError.message}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={async () => {
                setSequentialError(null);
                setMetrics(prev => ({
                  ...prev,
                  [firstEnvironment]: { ...prev[firstEnvironment], isLoading: true, error: null }
                }));
                const result = await startLoadGenSingle(firstEnvironment, {
                  duration: '3m',
                  devicesUsed: '1000'
                });
                setMetrics(prev => ({
                  ...prev,
                  [firstEnvironment]: {
                    ...prev[firstEnvironment],
                    isLoading: false,
                    error: result.success ? null : `Start failed: ${result.error}`,
                    successMessage: result.success ? 'Race started' : null
                  }
                }));
                if (!result.success) {
                  setSequentialError({ env: firstEnvironment, message: result.error || 'Unknown error' });
                } else {
                  setTimeout(() => {
                    setMetrics(prev => ({
                      ...prev,
                      [firstEnvironment]: { ...prev[firstEnvironment], successMessage: null }
                    }));
                  }, 3000);
                }
              }}
              style={{ padding: '6px 16px', backgroundColor: '#dc2626', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Retry
            </button>
            <button
              onClick={async () => {
                const secondEnv: 'heimdall' | 'nlb' = firstEnvironment === 'heimdall' ? 'nlb' : 'heimdall';
                setSequentialError(null);
                setSequentialPhase(SequentialPhase.RunningSecond);
                
                setMetrics(prev => ({
                  ...prev,
                  [secondEnv]: { ...prev[secondEnv], isLoading: true, error: null }
                }));
                const result = await startLoadGenSingle(secondEnv, {
                  duration: '3m',
                  devicesUsed: '1000'
                });
                setMetrics(prev => ({
                  ...prev,
                  [secondEnv]: {
                    ...prev[secondEnv],
                    isLoading: false,
                    error: result.success ? null : `Start failed: ${result.error}`,
                    successMessage: result.success ? 'Race started' : null
                  }
                }));
                if (result.success) {
                  console.log(`Sequential: skipped ${firstEnvironment}, started ${secondEnv}`);
                  setTimeout(() => {
                    setMetrics(prev => ({
                      ...prev,
                      [secondEnv]: { ...prev[secondEnv], successMessage: null }
                    }));
                  }, 3000);
                } else {
                  console.error(`Sequential: ${secondEnv} start failed:`, result.error);
                }
              }}
              style={{ padding: '6px 16px', backgroundColor: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Skip to {firstEnvironment === 'heimdall' ? 'NLB' : 'Heimdall'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
        <EnvironmentMetrics
          environment="heimdall"
          label="Red Car (Heimdall)"
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