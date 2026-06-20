# Requirements Document

## Introduction

This is a net-new feature (not an extension of any prior dashboard work). It delivers a live comparison dashboard for the RTB Fabric workshop that lets a participant launch a load test and watch an accurate, real-time, side-by-side latency comparison between two connectivity paths to the same bidder backend:

- **NLB** — the traditional Network Load Balancer path (`rtb-env: nlb`)
- **RTB Fabric** — the AWS RTB Fabric path (`rtb-env: rtb-fabric`)

The workshop runs both paths at a fixed request rate against an identical bidder, so throughput is held constant and **latency (and tail/error behavior) is the variable being demonstrated**. The dashboard must make that difference legible live, and must embed the existing workshop terminal in the same interface so participants work from a single URL.

This feature spans three repositories:
- **`guidance-rtb`** — the load-generator emits live interval latency data during a run (in addition to its existing end-of-run report).
- **`dash-rtb`** — a new dashboard backend service and a rebuilt frontend; the legacy dashboard stack is retired.
- **`rtb-fabric-workshop`** — CloudFront and ttyd changes to unify the dashboard and terminal behind one URL.

### Foundational decisions (constraints for all requirements)

1. **Latency is measured client-side by the load-generator.** It is the only vantage point that observes the NLB-vs-Fabric data-path difference. Bidder-side Prometheus metrics (via metric-watcher) measure server-internal processing only and are NOT the source of the comparison.
2. **Browser transport is Server-Sent Events (SSE)**, one-directional, not WebSocket.
3. **The dashboard service runs in EKS; the ttyd terminal stays on the workshop EC2 instance.** Unification happens at the CloudFront layer.
4. **The legacy SAM / Cognito / API Gateway WebSocket / DynamoDB dashboard stack is retired**, not extended.
5. **Security is the top priority, then reliability, then performance**, per workshop and Well-Architected guidance.

### Non-goals

- Using Prometheus/metric-watcher as the latency source for the comparison (server-side panel is optional only — see Requirement 12).
- Sharing a single shell session between the embedded terminal and any standalone terminal URL.
- Persisting historical run archives beyond the current/most-recent run (no database).

## Requirements

### Requirement 1: Load-generator live latency streaming

**User Story:** As a workshop participant, I want the load-generator to publish latency data continuously while a test runs, so that the dashboard can show live results instead of only a single summary at the end.

#### Acceptance Criteria

1. WHILE a load test is running THE load-generator SHALL emit an interval snapshot message at a fixed cadence (default 1 second, configurable).
2. WHEN computing an interval snapshot THE load-generator SHALL calculate percentile latencies (p50, p90, p95, p99), max, and mean over a tumbling window covering only that interval, not cumulative since test start.
3. WHEN emitting an interval snapshot THE load-generator SHALL include: the environment tag (`rtb-env`), elapsed seconds since test start, achieved request rate, success rate, per-status-code counts for the window, and windowed latency-distribution bucket counts.
4. WHEN a load test completes THE load-generator SHALL still emit its existing authoritative end-of-run report unchanged.
5. WHERE interval and final metrics overlap THE load-generator SHALL compute both with the same measurement methodology so the live view reconciles with the final summary.
6. IF emitting an interval snapshot fails THEN the load-generator SHALL log the error and continue the test and subsequent emissions without aborting.
7. WHEN streaming is not configured (no report endpoint) THE load-generator SHALL run exactly as it does today with no behavioral change.

### Requirement 2: Accurate, aligned comparison

**User Story:** As a workshop presenter, I want the two environments compared under controlled, aligned conditions, so that the latency difference reflects the data path and not test variance.

#### Acceptance Criteria

1. WHEN a simultaneous comparison run is launched THE system SHALL run the NLB and RTB Fabric load tests concurrently against the same bidder backend with identical payload profile, request rate, and duration.
2. WHEN plotting time-based data THE system SHALL align both environments on elapsed-time-since-test-start, not wall-clock time.
3. WHEN rendering any shared chart THE system SHALL use a common, pinned axis scale across both environments so the difference is not visually flattened by independent auto-scaling.
4. WHEN tagging emitted data THE system SHALL identify each environment unambiguously using `rtb-env` values `nlb` and `rtb-fabric`.
5. WHEN both environments use windowed metrics THE system SHALL apply identical window size and percentile definitions to both.

### Requirement 3: Dashboard ingestion and SSE fan-out service

**User Story:** As a system, I want a single backend service that receives load-generator data and streams it to connected browsers, so that the live dashboard updates without the complexity of the retired WebSocket/Lambda stack.

#### Acceptance Criteria

1. THE dashboard service SHALL expose an authenticated ingestion endpoint that accepts interval snapshots and final reports from the load-generator.
2. WHEN a valid message is ingested THE service SHALL fan it out to all connected browser clients over SSE.
3. WHEN a message arrives without a recognized `rtb-env` value THE service SHALL reject or ignore it and log a warning, without disrupting other clients.
4. THE dashboard service SHALL serve the static frontend assets.
5. THE dashboard service SHALL run as a single deployable unit in the existing EKS cluster, packaged and deployed with the same Helm pattern used by other workshop components.
6. THE dashboard service SHALL receive load-generator traffic in-cluster (the load-generator and service are both in EKS).
7. WHERE a browser client disconnects THE service SHALL release that client's resources and continue serving others.

### Requirement 4: Run control (individual or simultaneous)

**User Story:** As a workshop participant, I want to run a load test against NLB only, RTB Fabric only, or both at the same time, so that I can evaluate each path in isolation and also measure whether running both on shared hardware affects performance.

#### Acceptance Criteria

1. THE control endpoint SHALL support launching a run in three modes: NLB only, RTB Fabric only, or both environments simultaneously.
2. WHEN a single-environment run is launched THE system SHALL start only the selected environment with the specified rate, duration, and payload parameters.
3. WHEN a simultaneous run is launched THE system SHALL start both environments concurrently with identical rate, duration, and payload parameters (per Requirement 2).
4. WHEN a participant requests a stop THE system SHALL terminate the in-progress run for whichever environment(s) are currently running.
5. IF launching a requested environment fails THEN the system SHALL surface which environment failed and SHALL NOT silently present a one-sided or partial run as a complete comparison.
6. WHILE a run is in progress for an environment THE system SHALL prevent or clearly handle a new launch request for that same environment to avoid overlapping/ambiguous data.
7. WHERE the control endpoint launches workload THE associated identity SHALL be scoped to the minimum permissions required to launch the load-generator workload.
8. WHEN presenting results THE dashboard SHALL make clear which mode produced the data (single-environment vs simultaneous) so isolated-vs-contended performance can be compared meaningfully.
9. THE system SHALL be built to support both individual and simultaneous modes from the first pass, with the run mode selectable at launch time.
10. THE run controls SHALL expose test **duration** as the only user-selectable parameter, defaulting to 5 minutes and selectable within a bounded range; rate, devices, and workers SHALL remain fixed server-side constants (reflecting the ~1,000 TPS RTB Fabric ceiling).
11. WHEN a run is launched THE system SHALL validate and clamp the requested duration to the allowed range, and apply the same duration and fixed parameters to every selected environment.

### Requirement 5: Readiness gating of run controls

**User Story:** As a workshop participant, I want the load-test controls to stay locked until the resources they depend on actually exist, so that I can't trigger a run that is guaranteed to fail because setup isn't finished.

#### Acceptance Criteria

1. WHILE an environment has not been verified ready THE dashboard SHALL present that environment's run controls in a disabled, non-actionable state.
2. THE dashboard SHALL provide an explicit "Verify configuration" action that, when invoked, queries the observable readiness signals (the RTB Fabric gateway + link status and the NLB target) to determine per-environment readiness — rather than assuming readiness or relying on elapsed time.
3. WHEN verification reports an environment ready THE dashboard SHALL enable that environment's run controls.
4. WHEN an environment is not ready THE dashboard SHALL communicate what is pending (for example, "RTB Fabric link not yet ACTIVE") so the participant knows what to complete.
5. WHERE only one environment is ready THE dashboard SHALL allow launching that environment individually while keeping the not-ready environment's controls disabled.
6. WHEN a verification completes THE dashboard SHALL reflect the result without a full page reload, AND the last verified state SHALL persist across page reloads without re-querying the underlying APIs.
7. IF readiness cannot be determined THEN the system SHALL default to controls disabled (fail safe) rather than enabling actions that may fail.
8. THE system SHALL NOT poll the readiness signals on a timer; it SHALL query the RTB Fabric and NLB APIs only in response to an explicit verification action and when launching a run, to avoid unnecessary load on the RTB Fabric service while the dashboard is idle.

### Requirement 6: Live state and late-joiner snapshot

**User Story:** As a participant who opens the dashboard after a run has started, I want to see the run so far, so that I'm not staring at a blank chart mid-demo.

#### Acceptance Criteria

1. WHILE a run is active THE dashboard service SHALL retain the current run's series in memory.
2. WHEN a browser establishes an SSE connection mid-run THE service SHALL first send a snapshot of the run so far, then stream subsequent updates.
3. WHEN a run completes THE service SHALL retain the most recent completed run's data for display until a new run starts or it is reset.
4. THE dashboard service SHALL hold run state in memory only and SHALL NOT require a database.

### Requirement 7: Comparison visualization

**User Story:** As a workshop observer, I want clear, responsive visuals that foreground latency, so that the RTB Fabric advantage is obvious at a glance on a laptop, projector, or phone.

#### Acceptance Criteria

1. THE dashboard SHALL display KPI tiles for current p99, p50, mean, throughput, and error rate, each showing NLB and RTB Fabric values with the delta between them.
2. THE dashboard SHALL display a live latency time-series chart overlaying both environments, defaulting to p99, with elapsed time on the x-axis.
3. THE dashboard SHALL display a latency distribution view (CDF, "percent of requests under X ms") overlaying both environments.
4. THE dashboard SHALL display a tail/reliability panel showing per-environment timeout/error counts, requests over a high-latency threshold, and max latency.
5. THE dashboard SHALL prominently display the fixed request rate so viewers understand throughput is held constant and latency is the variable.
6. THE dashboard SHALL use a consistent per-environment visual encoding (color and a non-color cue such as line style) across every panel.
7. THE dashboard SHALL render legibly across desktop, projector, and mobile widths (responsive layout, high-contrast, large type).
8. WHEN a single-environment run is shown THE dashboard SHALL render cleanly without implying a missing second environment is an error.
9. WHEN no run data is available THE dashboard SHALL present a clear empty/idle state.

### Requirement 8: Embedded workshop terminal

**User Story:** As a workshop participant, I want the workshop terminal available inside the dashboard, so that I can run setup commands and watch the comparison from one place.

#### Acceptance Criteria

1. THE dashboard SHALL provide a control that opens and closes an in-page terminal panel (CloudShell-style).
2. WHEN the terminal panel is open THE dashboard SHALL embed the existing ttyd terminal (it already provides an xterm.js frontend) rather than reimplementing a terminal.
3. WHEN the terminal panel is resized THE embedded terminal SHALL reflow to the new dimensions.
4. THE embedded terminal SHALL execute the shell on the workshop EC2 instance (which holds the repo, credentials, kubeconfig, and aliases), not in the dashboard's EKS pod.
5. THE embedded terminal SHALL preserve the full interactive capabilities of the current standalone terminal.

### Requirement 9: Unified single-URL access

**User Story:** As a workshop organizer, I want participants to use one URL for both the dashboard and the terminal, so that we stop publishing two separate links.

#### Acceptance Criteria

1. THE system SHALL serve the dashboard and the terminal under a single public origin so the embedded terminal is same-origin to the dashboard.
2. THE system SHALL route dashboard requests and terminal requests by path under that single origin (dashboard at the root path, terminal under a dedicated path prefix).
3. WHEN the terminal is served under a path prefix THE terminal SHALL be configured so its own asset and connection URLs resolve correctly under that prefix.
4. THE terminal path SHALL support the terminal's interactive connection upgrade (WebSocket) through the shared distribution without caching that path.
5. WHEN unification is complete THE workshop SHALL publish one URL instead of two.

### Requirement 10: Security and access control

**User Story:** As a workshop owner, I want the combined interface to be safe to expose, so that an admin-capable shell and the control plane are not abusable.

#### Acceptance Criteria

1. THE terminal SHALL remain behind an authentication gate; an unauthenticated user SHALL NOT reach an interactive shell.
2. THE system SHALL restrict who may embed the terminal so it can only be framed by the dashboard origin (anti-clickjacking), and SHALL NOT expose it with permissive framing to arbitrary origins.
3. THE ingestion and control endpoints SHALL require authentication and SHALL reject unauthenticated requests.
4. THE frontend bundle and client-delivered configuration SHALL NOT contain long-lived secrets or API keys.
5. THE terminal-hosting instance SHALL continue to accept inbound traffic only from the shared distribution, not from the public internet directly.
6. WHERE the control endpoint can launch workloads THE associated identity SHALL be scoped to the minimum permissions required.
7. WHEN authentication is required across the dashboard and terminal THE system SHALL avoid forcing the participant through redundant separate logins for the unified experience.

### Requirement 11: Packaging, build pipeline, deployment, and retirement of the legacy stack

**User Story:** As the workshop maintainer, I want the new dashboard built and deployed through the same pipeline as the other workshop containers and the old stack removed, so that the workshop has fewer moving parts and is reliable during live events.

#### Acceptance Criteria

1. THE dashboard service SHALL be packaged as a container image.
2. THE dashboard service image SHALL be built and pushed to the container registry via CodeBuild, consistent with the existing build pattern used for other workshop containers (e.g., metric-watcher and load-generator), including an analogous buildspec and build invocation.
3. WHEN the workshop build pipeline runs THE dashboard image SHALL be produced and pushed without manual local build steps.
4. THE dashboard service SHALL be deployed via a Helm chart consistent with existing workshop components.
5. THE workshop provisioning SHALL stand up the unified single-origin routing as part of normal deployment.
6. THE legacy dashboard stack (Cognito, API Gateway WebSocket API, associated Lambdas, and DynamoDB tables) SHALL be removed from the workshop provisioning path.
7. WHEN the workshop is deployed end-to-end THE dashboard, live streaming, run control, and embedded terminal SHALL all function without manual post-deployment wiring.
8. THE solution SHALL favor the minimum number of new components and files necessary to meet these requirements.

### Requirement 12: Optional backend-health context (lower priority)

**User Story:** As a presenter, I optionally want a backend-health view confirming the bidder behaved identically across both runs, so that I can reinforce that the data path is the only variable.

#### Acceptance Criteria

1. WHERE a backend-health view is included THE system MAY source bidder-side metrics (e.g., throughput, no-bid rate, processing time, target up/down) from Prometheus.
2. WHEN a backend-health view is shown THE system SHALL present it as supporting context, clearly distinct from the authoritative client-measured latency comparison.
3. THE backend-health view SHALL NOT be a prerequisite for the core comparison to function (it is optional and may be deferred).
