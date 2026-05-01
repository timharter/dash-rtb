# Design Document

## Overview

This design extends the existing single-environment race tracking system to support dual-environment tracking. The system will maintain a single shared race state machine while tracking separate metrics, baselines, and results for two environments: Heimdall (Red Car) and NLB (Blue Car). The design preserves the existing state flow (NotReady → Pending → Ready → Running → Complete) while duplicating data structures and API calls to support both environments simultaneously.

## Architecture

### High-Level Architecture

The system follows a client-side architecture with three main integration points:

1. **Dual LoadGen API Integration**: Two separate API endpoints for race control
2. **WebSocket Message Router**: Routes incoming messages based on "rtb-env" field
3. **Dual State Tracking**: Maintains separate metrics and results for each environment

```
┌─────────────────────────────────────────────────────────────┐
│                     Race Control UI                          │
│  (Single Shared State Machine: NotReady → Pending → etc.)   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ├─────────────────┬─────────────────┐
                          │                 │                 │
                    ┌─────▼─────┐     ┌────▼────┐     ┌─────▼─────┐
                    │ LoadGen   │     │WebSocket│     │ LoadGen   │
                    │ API #1    │     │ Router  │     │ API #2    │
                    │(Heimdall) │     │         │     │  (NLB)    │
                    └───────────┘     └────┬────┘     └───────────┘
                                           │
                          ┌────────────────┴────────────────┐
                          │                                 │
                    ┌─────▼─────┐                    ┌──────▼──────┐
                    │ Heimdall  │                    │    NLB      │
                    │  Metrics  │                    │   Metrics   │
                    │  Display  │                    │   Display   │
                    └───────────┘                    └─────────────┘
```

### State Management

The system maintains a single shared race state but tracks environment-specific data separately:

**Shared State:**
- `raceState`: NotReady | Pending | Ready | Running | Complete
- `lastRaceCompletionTime`: timestamp for reset logic

**Per-Environment State:**
- `currentCount[env]`: Current bid requests since race start
- `totalBidRequests[env]`: Total bid requests from metric-watcher
- `prewarmBaseline[env]`: Baseline captured at race start
- `raceReport[env]`: Final race results
- `prewarmComplete[env]`: Boolean flag for Pending → Ready transition
- `raceComplete[env]`: Boolean flag for Running → Complete transition

## Components and Interfaces

### 1. Enhanced LoadGen API Module

**File**: `src/loadgen-api.ts`

**Purpose**: Manage API calls to both LoadGen endpoints

**New Interface**:
```typescript
interface LoadGenConfig {
  apiUrl: string;
  apiKey: string;
}

const LOADGEN_CONFIGS = {
  heimdall: {
    apiUrl: 'https://zlvhc6vzkk.execute-api.us-east-1.amazonaws.com/prod/',
    apiKey: '12345'
  },
  nlb: {
    apiUrl: 'https://prc1iaqdob.execute-api.us-east-1.amazonaws.com/prod/',
    apiKey: '67890'
  }
};
```

**New Functions**:
- `startLoadGenDual(params)`: Calls both APIs simultaneously using Promise.all
- `stopLoadGenDual()`: Calls both APIs simultaneously using Promise.all
- Individual functions remain for single-environment calls if needed

### 2. Enhanced MessageDisplay Component

**File**: `src/components/MessageDisplay.tsx`

**Purpose**: Manage race control and display metrics for both environments

**State Structure**:
```typescript
interface EnvironmentMetrics {
  currentCount: number;
  totalBidRequests: number;
  prewarmBaseline: number;
  raceReport: RaceReport | null;
  prewarmComplete: boolean;
  raceComplete: boolean;
}

const [metrics, setMetrics] = useState<{
  heimdall: EnvironmentMetrics;
  nlb: EnvironmentMetrics;
}>({
  heimdall: { currentCount: 0, totalBidRequests: 0, prewarmBaseline: 0, raceReport: null, prewarmComplete: false, raceComplete: false },
  nlb: { currentCount: 0, totalBidRequests: 0, prewarmBaseline: 0, raceReport: null, prewarmComplete: false, raceComplete: false }
});
```

**Message Handler Logic**:
```typescript
const handleMessage = (event: MessageEvent) => {
  const data = JSON.parse(event.data);
  const env = data.data?.['rtb-env'] || data['rtb-env'];
  
  if (!env || (env !== 'heimdall' && env !== 'nlb')) {
    console.warn('Missing or invalid rtb-env:', env);
    return;
  }
  
  // Route to appropriate handler based on message type
  if (isLoadGenFinalReport(data)) {
    handleLoadGenReport(env, data);
  } else if (isMetricWatcherMessage(data)) {
    handleMetricWatcher(env, data);
  }
};
```

**State Transition Logic**:
- Pending → Ready: Transition when BOTH `prewarmComplete` flags are true
- Running → Complete: Transition when BOTH `raceComplete` flags are true

### 3. Environment Metrics Display Component

**New Component**: `src/components/EnvironmentMetrics.tsx`

**Purpose**: Display metrics for a single environment

**Props**:
```typescript
interface EnvironmentMetricsProps {
  environment: 'heimdall' | 'nlb';
  label: string;
  color: string;
  currentCount: number;
  totalBidRequests: number;
  raceReport: RaceReport | null;
}
```

**Rendering**:
- Color-coded border and labels (red for Heimdall, blue for NLB)
- Current Count display
- Total Bid Requests display
- Race Results section (earliest, latest, end, duration, wait, requests, throughput, success)

## Data Models

### RaceReport
```typescript
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
```

### WebSocket Message Formats

**Metric-Watcher Message**:
```json
{
  "messageType": "report",
  "data": {
    "timestamp": "2025-10-01T19:55:12.182430244Z",
    "type": "metrics",
    "source": "metric-watcher",
    "rtb-env": "heimdall",
    "metrics": {
      "bidder_bid_request_received_number_...": 12345,
      ...
    }
  }
}
```

**LoadGen Final Report**:
```json
{
  "messageType": "report",
  "data": {
    "buckets": {...},
    "bytes_in": {...},
    "bytes_out": {...},
    "duration": 180074138193,
    "earliest": "2025-10-01T19:51:45.375513014Z",
    "end": "2025-10-01T19:54:45.532064065Z",
    "latencies": {...},
    "latest": "2025-10-01T19:54:45.449651207Z",
    "requests": 12279912,
    "rtb-env": "heimdall",
    "source": "load-generator",
    "throughput": 68086.63314456759,
    "success": 0.998887695612151,
    "type": "report",
    "wait": 82412858
  }
}
```

## Error Handling

### API Call Failures

**Strategy**: Independent error handling per environment

**Implementation**:
```typescript
const startLoadGenDual = async (params) => {
  const results = await Promise.allSettled([
    startLoadGen(LOADGEN_CONFIGS.heimdall, params),
    startLoadGen(LOADGEN_CONFIGS.nlb, params)
  ]);
  
  results.forEach((result, index) => {
    const env = index === 0 ? 'heimdall' : 'nlb';
    if (result.status === 'rejected') {
      console.error(`${env} API call failed:`, result.reason);
      // Display error notification for this environment
    }
  });
};
```

### Missing rtb-env Field

**Strategy**: Log warning and ignore message

**Implementation**:
```typescript
if (!env || (env !== 'heimdall' && env !== 'nlb')) {
  console.warn('Missing or invalid rtb-env:', env, 'in message:', data);
  return; // Skip processing
}
```

### Partial State Transitions

**Strategy**: Only transition when BOTH environments are ready

**Example**: If Heimdall completes prewarm but NLB fails, system remains in Pending state until NLB also completes or user intervenes.

## Implementation Notes

### Configuration Management

Store both API configurations in `config.ts`:
```typescript
export const LOADGEN_CONFIGS = {
  heimdall: {
    apiUrl: 'https://zlvhc6vzkk.execute-api.us-east-1.amazonaws.com/prod/',
    apiKey: '12345'
  },
  nlb: {
    apiUrl: 'https://prc1iaqdob.execute-api.us-east-1.amazonaws.com/prod/',
    apiKey: '67890'
  }
};
```

### State Synchronization

Use a single `useEffect` hook with `raceState` dependency to ensure consistent state transitions across both environments.

### Performance Considerations

- Use `Promise.allSettled` instead of `Promise.all` to prevent one API failure from blocking the other
- Debounce metric updates if message frequency is high
- Use React.memo for EnvironmentMetrics component to prevent unnecessary re-renders
