# Requirements Document

## Introduction

This feature extends the existing race control system to support simultaneous tracking of two racing environments: a Red Car (Heimdall environment) and a Blue Car (NLB environment). The system will maintain a single Race Control interface that coordinates both environments simultaneously using the existing race state machine (NotReady → Pending → Ready → Running → Complete). Metric-watcher messages provide both Current Count and Total Bid Requests, while LoadGen final reports signal state transitions and provide race results.

## Requirements

### Requirement 1: Dual API Race Control with Shared State Machine

**User Story:** As a race operator, I want to control both racing environments simultaneously with a single control interface that maintains the existing race state logic, so that I can manage both races efficiently while preserving the current prewarm/start/stop/reset workflow.

#### Acceptance Criteria

1. WHEN the race state is NotReady AND the user clicks Prewarm THEN the system SHALL set currentCount to 0, transition to Pending state, and send prewarm requests (duration: 10s, devicesUsed: 1) to both API endpoints simultaneously
2. WHEN in Pending state AND LoadGen final reports are received from BOTH environments THEN the system SHALL set currentCount to 0 and transition to Ready state
3. WHEN the race state is Ready AND the user clicks Start THEN the system SHALL capture the current totalBidRequests as prewarmBaseline for both environments, transition to Running state, and send start requests (duration: 3m, devicesUsed: 1000) to both API endpoints simultaneously
4. WHEN the race state is Running AND the user clicks Stop THEN the system SHALL send stop requests to both API endpoints simultaneously
5. WHEN in Running state AND LoadGen final reports are received from BOTH environments THEN the system SHALL store the race reports for both environments, record the completion timestamp, and transition to Complete state
6. WHEN the race state is Complete AND the user clicks Reset AND more than 10 minutes have elapsed since completion THEN the system SHALL reset to NotReady state, clear all race reports, reset currentCount and prewarmBaseline to 0 for both environments, and clear the completion timestamp
7. WHEN the race state is Complete AND the user clicks Reset AND less than 10 minutes have elapsed since completion THEN the system SHALL reset to Ready state, clear race reports, reset currentCount to 0, and update prewarmBaseline to current totalBidRequests for both environments
8. IF either API call fails THEN the system SHALL display an error message indicating which environment failed without blocking the other environment

### Requirement 2: Second API Integration

**User Story:** As a system integrator, I want the application to communicate with the second racing environment API, so that the Blue Car (NLB) environment can be controlled alongside the Red Car (Heimdall) environment.

#### Acceptance Criteria

1. WHEN making API calls to the second environment THEN the system SHALL use the URL "https://prc1iaqdob.execute-api.us-east-1.amazonaws.com/prod/"
2. WHEN making API calls to the second environment THEN the system SHALL include the API key "dSd84ax4Iya7Govv8j76c3JuF7neUEQ2rIbgAgm4" in the request headers
3. WHEN the second API returns a response THEN the system SHALL handle it identically to the first API response
4. IF the second API is unreachable THEN the system SHALL display an appropriate error message without blocking the first API

### Requirement 3: Environment-Specific Data Routing

**User Story:** As a developer, I want incoming WebSocket messages to be routed to the correct environment display based on the "rtb-env" field, so that metrics from each environment are displayed separately.

#### Acceptance Criteria

1. WHEN a WebSocket message is received with "rtb-env": "heimdall" THEN the system SHALL route the data to the Red Car (Heimdall) display
2. WHEN a WebSocket message is received with "rtb-env": "nlb" THEN the system SHALL route the data to the Blue Car (NLB) display
3. WHEN a message is received without an "rtb-env" field THEN the system SHALL log a warning and ignore the message
4. WHEN a message is received with an unknown "rtb-env" value THEN the system SHALL log a warning and ignore the message

### Requirement 4: Dual Environment Metrics Display

**User Story:** As a race observer, I want to see separate Current Count, Total Bid Requests, and race results for each environment, so that I can compare the performance of both racing environments side by side.

#### Acceptance Criteria

1. WHEN the UI loads THEN the system SHALL display two distinct metric panels (one for Heimdall, one for NLB)
2. WHEN metric-watcher data is received for an environment THEN the system SHALL update both the Current Count and Total Bid Requests for that specific environment
3. WHEN LoadGen final report is received for an environment THEN the system SHALL update the race results for that specific environment
4. WHEN displaying metrics THEN the system SHALL clearly label which environment each metric panel represents (Red Car/Heimdall and Blue Car/NLB)
5. WHEN no data has been received for an environment THEN the system SHALL display a default or empty state for that environment's metrics

### Requirement 5: Metric-Watcher Data Processing Per Environment

**User Story:** As a system, I want to correctly parse metric-watcher messages that include the "rtb-env" field, so that both Current Count and Total Bid Requests are calculated and displayed in the correct environment panel.

#### Acceptance Criteria

1. WHEN a metric-watcher message is received THEN the system SHALL extract the "rtb-env" value from the message
2. WHEN the message has "messageType": "report" AND "data.type": "metrics" AND "data.source": "metric-watcher" THEN the system SHALL process it as a metric-watcher message
3. WHEN processing a metric-watcher message THEN the system SHALL sum all metrics with keys starting with "bidder_bid_request_received_number" to calculate totalBidRequests for that environment
4. WHEN processing a metric-watcher message THEN the system SHALL update the totalBidRequestsState for the corresponding environment
5. WHEN in Running state AND processing a metric-watcher message THEN the system SHALL calculate currentCount as (totalBidRequests - prewarmBaseline) for the corresponding environment
6. WHEN in Pending or Ready state AND processing a metric-watcher message THEN the system SHALL NOT update currentCount
7. IF the "rtb-env" field is missing from a metric-watcher message THEN the system SHALL log an error and not update any display

### Requirement 6: Load-Generator Final Report Processing Per Environment

**User Story:** As a system, I want to correctly parse load-generator final reports that include the "rtb-env" field, so that race state transitions and race results are handled correctly for each environment.

#### Acceptance Criteria

1. WHEN a message contains "source": "load-generator" THEN the system SHALL recognize it as a LoadGen final report
2. WHEN a LoadGen final report is received THEN the system SHALL extract the "rtb-env" value from the message
3. WHEN in Pending state AND LoadGen final reports are received for BOTH environments THEN the system SHALL set currentCount to 0 for both environments and transition to Ready state
4. WHEN in Running state AND a LoadGen final report is received for an environment THEN the system SHALL extract and store the race report data (earliest, latest, end, duration, wait, requests, throughput, success) for that environment
5. WHEN in Running state AND LoadGen final reports are received for BOTH environments THEN the system SHALL record the completion timestamp and transition to Complete state
6. IF the "rtb-env" field is missing from a LoadGen final report THEN the system SHALL log an error and not process the report

### Requirement 7: Prewarm Baseline Tracking Per Environment

**User Story:** As a system, I want to correctly track the prewarm baseline for each environment, so that Current Count accurately reflects only NEW bid requests received during the race.

#### Acceptance Criteria

1. WHEN the Start button is clicked THEN the system SHALL capture the current totalBidRequestsState value as prewarmBaseline for each environment separately
2. WHEN in Running state AND metric-watcher data is received THEN the system SHALL calculate currentCount as (totalBidRequests - prewarmBaseline) for the corresponding environment
3. WHEN Reset is clicked AND less than 10 minutes have elapsed THEN the system SHALL update prewarmBaseline to the current totalBidRequestsState for each environment
4. WHEN Reset is clicked AND more than 10 minutes have elapsed THEN the system SHALL reset prewarmBaseline to 0 for both environments
5. WHEN Prewarm is clicked THEN the system SHALL set currentCount to 0 for both environments

### Requirement 8: Visual Distinction Between Environments

**User Story:** As a race observer, I want to easily distinguish between the two environment displays, so that I don't confuse metrics from different environments.

#### Acceptance Criteria

1. WHEN displaying the Heimdall environment metrics THEN the system SHALL use visual indicators associated with the Red Car (e.g., red color scheme, "Red Car" label)
2. WHEN displaying the NLB environment metrics THEN the system SHALL use visual indicators associated with the Blue Car (e.g., blue color scheme, "Blue Car" label)
3. WHEN both environment panels are displayed THEN the system SHALL position them in a way that makes side-by-side comparison easy
4. WHEN an environment is not responding THEN the system SHALL visually indicate the inactive or error state for that specific environment
5. WHEN displaying race results THEN the system SHALL show results for both environments in separate sections with clear labels
