# Implementation Plan

- [x] 1. Update configuration to support dual LoadGen APIs
  - Add second API configuration (NLB) to config.ts with URL and API key
  - Restructure LOADGEN_CONFIG to LOADGEN_CONFIGS object with heimdall and nlb keys
  - _Requirements: 2.1, 2.2_

- [x] 2. Enhance LoadGen API module for dual-environment support
  - [x] 2.1 Create dual API call functions
    - Implement `startLoadGenDual(params)` that calls both APIs using Promise.allSettled
    - Implement `stopLoadGenDual()` that calls both APIs using Promise.allSettled
    - Return results indicating success/failure for each environment
    - _Requirements: 1.1, 1.3, 1.4, 1.8_

  - [x] 2.2 Refactor existing API functions to accept config parameter
    - Modify `startLoadGen` to accept a config object as first parameter
    - Modify `stopLoadGen` to accept a config object as first parameter
    - Update function signatures to support both single and dual calls
    - _Requirements: 2.3_

- [x] 3. Create EnvironmentMetrics display component
  - [x] 3.1 Create new component file and interface
    - Create `src/components/EnvironmentMetrics.tsx`
    - Define EnvironmentMetricsProps interface with environment, label, color, currentCount, totalBidRequests, and raceReport
    - _Requirements: 4.1, 4.4, 8.1, 8.2_

  - [x] 3.2 Implement metrics display UI
    - Render color-coded container with border matching environment color
    - Display environment label (Red Car/Heimdall or Blue Car/NLB)
    - Display Current Count value
    - Display Total Bid Requests value
    - Display race results section with all report fields (earliest, latest, end, duration, wait, requests, throughput, success)
    - Show "No race results available" when raceReport is null
    - _Requirements: 4.2, 4.3, 4.5, 8.3, 8.5_

- [x] 4. Refactor MessageDisplay component for dual-environment tracking
  - [x] 4.1 Update state structure for dual environments
    - Define EnvironmentMetrics interface
    - Replace single state variables with metrics object containing heimdall and nlb properties
    - Initialize both environments with default values (currentCount: 0, totalBidRequests: 0, prewarmBaseline: 0, raceReport: null, prewarmComplete: false, raceComplete: false)
    - Convert prewarmBaseline and lastRaceCompletionTime to support both environments
    - _Requirements: 4.1, 5.1_

  - [x] 4.2 Implement message routing logic
    - Extract rtb-env field from incoming WebSocket messages
    - Validate rtb-env is either "heimdall" or "nlb"
    - Log warning and return early if rtb-env is missing or invalid
    - Route messages to appropriate handler based on environment
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.3 Implement metric-watcher message handler
    - Check for messageType "report", data.type "metrics", and data.source "metric-watcher"
    - Sum all metrics with keys starting with "bidder_bid_request_received_number"
    - Update totalBidRequests for the corresponding environment
    - If in Running state, calculate currentCount as (totalBidRequests - prewarmBaseline) for that environment
    - If in Pending or Ready state, do not update currentCount
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 4.4 Implement LoadGen final report handler
    - Check for presence of data.latencies, data.buckets, data.bytes_in, data.bytes_out, and data.end
    - Extract rtb-env from message
    - If in Pending state, set prewarmComplete flag for that environment
    - If in Pending state and both prewarmComplete flags are true, set currentCount to 0 for both and transition to Ready
    - If in Running state, extract and store race report data for that environment
    - If in Running state and both raceComplete flags are true, record completion timestamp and transition to Complete
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 1.2, 1.5_

  - [x] 4.5 Update Prewarm button handler
    - Set currentCount to 0 for both environments
    - Transition to Pending state
    - Call startLoadGenDual with duration: 10s, devicesUsed: 1
    - Handle errors from either API
    - _Requirements: 1.1, 1.8_

  - [x] 4.6 Update Start button handler
    - Capture current totalBidRequests as prewarmBaseline for both environments
    - Transition to Running state
    - Call startLoadGenDual with duration: 3m, devicesUsed: 1000
    - Handle errors from either API
    - _Requirements: 1.3, 1.8, 7.1_

  - [x] 4.7 Update Stop button handler
    - Call stopLoadGenDual
    - Handle errors from either API
    - _Requirements: 1.4, 1.8_

  - [x] 4.8 Update Reset button handler
    - Calculate time elapsed since lastRaceCompletionTime
    - If more than 10 minutes: reset to NotReady, clear all reports, reset currentCount and prewarmBaseline to 0 for both, clear completion timestamp
    - If less than 10 minutes: reset to Ready, clear reports, reset currentCount to 0, update prewarmBaseline to current totalBidRequests for both
    - _Requirements: 1.6, 1.7, 7.3, 7.4_

  - [x] 4.9 Update UI to render dual environment panels
    - Import and render two EnvironmentMetrics components
    - Pass heimdall metrics to first component with red color and "Red Car (Heimdall)" label
    - Pass nlb metrics to second component with blue color and "Blue Car (NLB)" label
    - Position components side-by-side for easy comparison
    - _Requirements: 4.1, 4.4, 8.1, 8.2, 8.3_

- [x] 5. Add error handling and user feedback
  - [x] 5.1 Implement API error notifications
    - Display error messages when API calls fail
    - Indicate which environment (Heimdall or NLB) experienced the error
    - Ensure errors don't block the other environment
    - _Requirements: 1.8, 2.4, 8.4_

  - [x] 5.2 Add visual indicators for environment status
    - Show loading/pending state for each environment during API calls
    - Show error state when environment is not responding
    - Show success state when environment completes operations
    - _Requirements: 8.4_

- [ ] 6. Integration and end-to-end verification
  - Verify complete race flow: NotReady → Prewarm → Pending → Ready → Start → Running → Complete → Reset
  - Test with both environments receiving data normally
  - Test with one environment failing API calls
  - Test with one environment not receiving WebSocket messages
  - Verify reset behavior at 9 minutes and 11 minutes after completion
  - Verify metrics display correctly for both environments throughout the race
  - _Requirements: All requirements_
