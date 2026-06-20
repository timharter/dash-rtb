# Design Document

## Overview

This design delivers a live NLB-vs-RTB-Fabric comparison dashboard with an embedded workshop terminal, served from a single URL. It replaces the legacy dash-rtb stack (Cognito + API Gateway WebSocket + report Lambdas + DynamoDB) and the separate `load-gen-lambda` (`LambdaHelmStack`) with one small in-cluster service plus a frontend, and unifies the dashboard and terminal behind the existing CloudFront distribution.

The work spans three repositories:

| Repo | Change |
|---|---|
| `guidance-rtb` | Load-generator emits live interval latency snapshots during a run; new dashboard service + Helm chart + CodeBuild wiring live here alongside the other workshop components. |
| `dash-rtb` | New frontend (rebuilt); retire the SAM stack and `load-gen-lambda`. |
| `rtb-fabric-workshop` | Extend the CloudFront distribution (second origin + `/dash/*` behavior), keep ttyd at root, retire legacy deploy phases. |

### Design principles applied

- **Security first, then reliability, then performance** (Well-Architected steering).
- **Minimal moving parts** — one container replaces five-plus serverless resources; launch via in-cluster RBAC instead of a Lambda + kubeconfig dance.
- **Single measurement source** — all comparison latency originates from the load-generator (client-side).

## Architecture

### Component topology

```
                        ┌──────────────────────── CloudFront (existing distribution) ────────────────────────┐
                        │  edge Basic-Auth (single gate)                                                      │
   participant ───────► │   /*        → workshop-origin (EC2: nginx → ttyd terminal)   [default behavior]     │
                        │   /dash/*   → dashboard-origin (EKS ALB → dashboard service) [new ordered behavior] │
                        └─────────────────────────────────────────────────────────────────────────────────────┘
                                   │                                              │
                          (root, terminal)                                (/dash/*, dashboard)
                                   ▼                                              ▼
                       ┌─────────────────────┐                      ┌──────────────────────────────┐
                       │ Workshop EC2         │                      │ Publisher/SSP EKS cluster     │
                       │  nginx :80           │                      │                                │
                       │  ttyd :8080 (xterm)  │                      │  ┌──────────────────────────┐  │
                       └─────────────────────┘                      │  │ dashboard service (Go)    │  │
                                                                     │  │  - static UI (/dash)      │  │
   browser (dashboard SPA) ──SSE /dash/stream──────────────────────►│  │  - SSE fan-out            │  │
   browser ──POST /dash/run, /dash/stop──────────────────────────► │  │  - POST /ingest (token)   │◄─┼── load-gen Jobs
   browser ──iframe src="/" (embedded terminal)────────────────────│  │  - readiness probe        │  │   (interval + final)
                                                                     │  │  - run control (client-go)│──┼─► create/delete
                                                                     │  └──────────────────────────┘  │   batch/v1 Jobs
                                                                     │         │ RBAC (Jobs)           │
                                                                     │         ▼                       │
                                                                     │  load-generator Job(s)          │
                                                                     │   nlb Job ─► NLB ─► bidder      │
                                                                     │   rtbfabric Job ─► Fabric ─► bidder
                                                                     └────────────────────────────────┘
```

### Cluster placement

The dashboard service is deployed to the **publisher/SSP EKS cluster**, co-located with the load-generator. This makes run-launch a same-cluster Kubernetes API call (no kubeconfig/eks-token bridging) and lets load-generator Jobs post interval data to the service over in-cluster DNS. The bidder, metric-watcher, and Prometheus run on the DSP cluster; the optional backend-health panel (Requirement 12) would therefore be cross-cluster and is deferred.

> Assumption to confirm: the dashboard's public ALB lives on the SSP cluster. If workshop networking favors the DSP cluster, the run-control path becomes cross-cluster and would revert to an eks-token bridge — flagged in Decisions.

### Run lifecycle (end to end)

1. **Verify** — controls start disabled. The participant clicks "Verify configuration"; the service checks the rtbfabric gateway + link status and the bidder NLB once, caches the result, and broadcasts per-environment readiness over SSE. The frontend enables each ready environment's controls. There is no background polling (Requirement 5).
2. **Launch** — the participant picks a mode (NLB only / RTB Fabric only / both) and a duration, then clicks Run. The browser calls `POST /dash/run`. The service creates one load-generator `batch/v1` Job per selected environment via the in-cluster Kubernetes API, each parameterized with its target URL, `rtb-env`, the fixed rate/devices/workers, the user-selected duration, and `--report-api-url` pointing at the service's own in-cluster `/ingest` endpoint.
3. **Stream** — each Job emits a windowed interval snapshot ~every second to `/ingest`. The service tags, buffers (per run, in memory), and fans out each snapshot over SSE to all connected browsers. Late joiners get a snapshot-on-connect replay (Requirement 6).
4. **Complete** — when a Job finishes, the load-generator posts its existing authoritative final report to `/ingest`; the service forwards it and marks that environment complete. Jobs self-clean via `ttlSecondsAfterFinished`.
5. **Stop** — `POST /dash/stop` deletes the active Job(s) by label for the requested environment(s).

## Component Design

### 1. Load-generator live streaming (`guidance-rtb`)

The current flow runs `attacker.Attack(...)` to completion, then posts one final report via `ReportAPIClient.SendReport`. We add a concurrent interval emitter without touching the hot path or the final report.

**Tap, don't block.** The attack hot path (`attack.go` `hit()` → `results.Add`) stays untouched. We add an optional non-blocking tap: each completed `Result`'s latency/code is offered to a buffered channel (drop-if-full to protect throughput, mirroring the existing `BufferedSummary` pattern). A separate aggregator goroutine owns a per-window `tdigest` plus counters.

**Tumbling window.** On each interval tick (`--report-interval`, default `1s`), the aggregator snapshots the current window (p50/p90/p95/p99, max, mean, request count, success count, per-status-code counts, and histogram-bucket counts reusing the existing `Histogram` buckets), computes elapsed seconds since `Attacker.began`, emits, and resets the window. Per-window (not cumulative) keeps the live series lively and reconcilable with the final report (Requirement 1.2, 2.5).

**Wiring.** `app.go` starts the aggregator before `Attack` and stops it after, then sends the final report exactly as today (Requirement 1.4). A new `SendInterval(msg)` method on the report client posts the interval message. Streaming engages only when `--report-api-url`/key are set; with no endpoint, behavior is unchanged (Requirement 1.7). Emission failures are logged and the run continues (Requirement 1.6).

**New config flags** (env-overridable via existing viper setup): `--report-interval` (default `1s`).

### 2. Dashboard service (`guidance-rtb/.../<new>`, Go)

A single Go binary (consistent with metric-watcher/load-generator; ARM64; tiny Alpine image) exposing:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /dash/` (+ assets) | edge Basic-Auth | Serve the SPA (embedded static files) |
| `GET /dash/stream` | edge Basic-Auth | SSE: readiness + interval + final + run-state events |
| `POST /dash/run` | edge Basic-Auth | Launch a run (mode: `nlb` \| `rtbfabric` \| `both`) |
| `POST /dash/stop` | edge Basic-Auth | Stop active run(s) |
| `POST /dash/verify` | edge Basic-Auth | Run RTB Fabric + NLB readiness checks on demand; unblock ready environments |
| `POST /ingest` | shared token | Receive interval + final messages — load-generator (in-cluster) and metric-watcher (DSP cluster, via ALB) |
| `GET /healthz` | none | Liveness/readiness probe |

**In-memory run state (no DB, Requirement 6).** A single current-run struct holds: run id, mode, start time, per-environment ordered list of interval snapshots, final reports, and completion flags. A ring/bounded slice caps memory (a 10-minute run at 1s ≈ 600 points/env). On a new run, the previous run is replaced (last completed run retained until then).

**SSE fan-out.** Clients register an in-memory subscriber channel; the service writes events as they arrive. On connect, it first replays the current run's buffered snapshots (snapshot-on-connect), then streams deltas. Disconnects drop the subscriber and free resources (Requirement 3.7, 6.2). One replica is sufficient for a workshop; SSE state is intentionally process-local.

**Run control via in-cluster RBAC (replaces `load-gen-lambda`).** Because the service runs in the same cluster as the load-generator, it creates `batch/v1` Jobs directly through the Kubernetes API (client-go) using its ServiceAccount — no kubeconfig, eks-token, or API Gateway. The Job spec is templated from the existing load-generator Job (image, nodeSelector `pool: benchmark`, args), parameterized per environment:

- `nlb` Job → `--target=<NLB target>` (resolved from the readiness probe's `elbv2` lookup), `--rtb-env=nlb`
- `rtbfabric` Job → `--target=<RTB Fabric target>` (resolved from the readiness probe's `rtbfabric` gateway+link lookup), `--rtb-env=rtbfabric`
- both → both Jobs created concurrently
- all Jobs → `--report-api-url=http://<svc>.<ns>.svc.cluster.local:<port>/ingest`, shared rate/duration/devices/workers, plus the ingest token header value via flag/env

Stop deletes Jobs by label selector. A run-in-progress guard prevents a second launch for an already-running environment (Requirement 4.6). **Duration is the only client-supplied test parameter** (default 5m, validated and clamped to a bounded range); rate, devices, and workers are fixed server-side constants reflecting the ~1,000 TPS RTB Fabric ceiling, so they cannot be tampered with from the client (Requirement 4.10–4.11).

**Readiness via on-demand verification (Requirement 5).** The service does **not** poll on a timer — to avoid loading the RTB Fabric API when no one is using the dashboard. Controls start disabled; the frontend exposes a **"Verify configuration"** action that calls `POST /dash/verify`, which runs the checks once, caches the per-environment result in memory, emits a `readiness` SSE event to all connected clients, and returns the result. The same checks resolve the launch target URLs (so "ready" provably means "launchable"), and the launch path re-runs them, so a stale cached "ready" can never produce a silent bad run (it fails with a clear per-environment error instead).

- **RTB Fabric ready** when the SSP requester gateway is `ACTIVE` and an associated link is `ACTIVE`, queried via the `rtbfabric` API (the link is created by the participant via `aws rtbfabric create-link`/`accept-link` in workshop module 1.4 — there are no CloudFormation exports for it). The query returns the gateway `domainName` and `linkId`, yielding the target `https://<domainName>/link/<linkId>/bidrequest`. The requester gateway is participant-created at runtime, so it is discovered via the rtbfabric API rather than configured at deploy time (exact enumerate operation to confirm during implementation).
- **NLB ready** when `elbv2:DescribeLoadBalancers --names rtb-bidder-external` returns an active load balancer with a DNS name, yielding the target `https://<dns>/bidrequest` (optionally also `DescribeTargetHealth` for healthy bidders).
- Unknown/error/missing ⇒ not-ready, with the reason surfaced to the UI (fail safe, Requirement 5.7).

The verified result is cached in the in-memory run state and replayed on SSE connect, so a page reload restores the unblocked state with no additional AWS call (Requirement 5.6). Verification runs only on the explicit user action (and at launch), bounded by a client in-flight disable plus a short server-side minimum interval to absorb repeated clicks (Requirement 5.8). The checks use account/region-level APIs read via an IRSA role scoped read-only to `rtbfabric` (gateways + links) and `elasticloadbalancing:Describe*` — no cross-cluster Kubernetes access is required (Requirement 9.6).

### 3. Frontend (`dash-rtb/app/dashboard-app`, rebuilt)

Served under `base: /dash/` (matches the existing CloudFront output convention). Recommended stack: **Vite + Svelte + uPlot** — component ergonomics with a tiny bundle and excellent streaming-update performance. Acceptable substitutes if the team prefers: plain TypeScript + uPlot (most minimal) or React + uPlot (most familiar). This is a reversible decision flagged below; the rest of the design is framework-agnostic.

**Data handling.** A single `EventSource('/dash/stream')` feeds a small store. Per environment, interval snapshots append to a bounded ring buffer keyed by elapsed seconds. Chart updates are batched to ~1–2 Hz / `requestAnimationFrame` (not per-message React/Svelte reactivity) and pushed to uPlot imperatively via `setData` to stay smooth on a projector.

**Panels (Requirement 7).**
- **KPI tiles** — current p99, p50, mean, throughput, error rate; each shows both environments and the delta. CSS-grid `auto-fit/minmax` so they wrap on mobile.
- **Live latency time-series** — both environments overlaid, default p99 (toggle p50/p95), x = elapsed seconds, **pinned y-axis** so the gap isn't auto-scaled away (Requirement 2.3).
- **CDF** ("percent of requests under X ms") — built from the windowed histogram buckets, overlaid per environment.
- **Tail/reliability** — per-environment 504/error counts, requests over a high-latency threshold, max latency.
- Fixed request rate shown prominently; consistent per-environment color **and** line style (Requirement 7.6). Single-environment runs render cleanly without a "missing data" look (Requirement 7.8); idle state when no run (7.9).

**Run controls.** A **"Verify configuration"** button runs the on-demand readiness check and unblocks each ready environment; the gating state comes from the last verification (cached and restored across reloads via the SSE snapshot), with a tooltip explaining what is pending or failed when disabled (Requirement 5.4, 5.6). Once unblocked: a mode selector (NLB / RTB Fabric / Both) + a **duration slider** (default 5 min, bounded range) as the only exposed test parameter, plus Run/Stop. Rate/devices/workers are shown read-only (fixed).

**Embedded terminal (Requirement 8).** A toggle opens a resizable bottom panel containing `<iframe src="/">` (the ttyd terminal at the distribution root — same origin as `/dash/`). ttyd's xterm.js fit-addon reflows the PTY when the panel resizes. No ttyd base-path change is needed because the terminal stays at root.

### 4. Unified CloudFront + terminal embedding (`rtb-fabric-workshop`)

The existing `CloudFrontDistribution` has one origin (`workshop-origin` = EC2 nginx→ttyd) on the default behavior, using managed **CachingDisabled** (`4135ea2d-…`) and **AllViewer** (`216adef6-…`) policies — which already pass WebSocket through for ttyd. Changes:

- **Add a second origin** `dashboard-origin` = the SSP cluster's dashboard ALB (HTTPS).
- **Add an ordered cache behavior** `/dash/*` → `dashboard-origin`, reusing CachingDisabled + AllViewer (SSE must not be cached; AllViewer forwards what the SPA needs). Keep the default `/*` behavior → `workshop-origin` (terminal stays at root).
- **Single edge auth.** Move the human gate to a CloudFront Function (viewer-request Basic-Auth) covering the whole distribution, and remove ttyd/nginx's own `auth_basic` so participants aren't prompted twice (Requirement 9.7). Both origins then trust edge-authorized requests. The dashboard's machine endpoints (`/ingest`) are in-cluster only and not exposed through CloudFront.
- **Frame-ancestors.** Since the terminal (root) is framed by the dashboard (`/dash/`) on the same origin, set `Content-Security-Policy: frame-ancestors 'self'` (via response headers) so it can only be embedded by its own origin (anti-clickjacking, Requirement 9.2). The EC2 security group stays locked to the CloudFront prefix list (Requirement 9.5).

The `RTBDashURL` output (`/dash/`) and `TerminalURL` (`/`) already match this layout; the workshop publishes the single CloudFront URL (Requirement 9.5 / single-URL goal).

### 5. Build, deploy, and legacy retirement (Requirement 11)

**Container build (mirror metric-watcher).** Add `buildspec-rtb-dashboard.yml`, `build-rtb-dashboard.sh`, and `Makefile` targets (`rtb-dashboard@build`/`@push`) plus a multi-stage `Dockerfile` (stage 1 builds the frontend with Vite; stage 2 builds the Go binary and embeds the built assets; final Alpine/ARM64 image). Image pushed to ECR `${STACK_NAME}-rtb-dashboard` via CodeBuild, consistent with the existing pattern (Requirement 11.1–11.3).

**Helm chart.** Add a `rtb-dashboard` chart (modeled on metric-watcher): Deployment (1 replica), Service, ServiceAccount + Role/RoleBinding (create/delete/list/watch `batch/jobs`, get/list `pods`), IRSA annotation for the scoped read-only `rtbfabric` + `elbv2` role, Ingress/ALB, and values for image, ingest token, namespace, and poll intervals (target URLs are resolved at runtime, not configured as values) (Requirement 11.4).

**Legacy retirement (Requirement 11.6).** Remove from the provisioning path: the dash-rtb SAM stack (Cognito, WebSocket API, OnConnect/OnDisconnect/SendMessage + report Lambdas, DynamoDB tables) and the `load-gen-lambda` `LambdaHelmStack`. The specific template edits that accomplish this (and the new deploy/build steps) are enumerated in the **Workshop Deployment Template Changes** section below.

## Workshop Deployment Template Changes (`ws-template-vsonly.yaml`)

This template is the deployment backbone — Workshop Studio provisions everything through it via SSM phases — so the feature's template changes are first-class work:

**Image builds (`StartContainerImageBuilds` step).** Add a third `aws codebuild start-build --project-name rtb-build-project --buildspec-override buildspec-rtb-dashboard.yml ...` alongside the existing metric-watcher and wss-loadgen builds, recording its build id for the build barrier. The load-gen streaming changes ship through the existing `buildspec-wss-loadgen.yml` image (no new build needed for the load-generator).

**RTBDash phase (`RTBDashSSMDocument`) — replace, don't extend.**
- Remove `StartSAMDeploy` (the `dashboard-app` SAM stack), `DeployLoadGenLambda` (`LambdaHelmStack`), and the `WaitForSAMAndPatchReportApi` patch step.
- Add `helm upgrade --install rtb-dashboard` onto `cluster2-ssp` with the dashboard image, ingest token, and the IRSA role annotation. Target URLs are **not** static helm values — the service resolves them at runtime via the readiness probe (rtbfabric gateway+link and the `rtb-bidder-external` NLB).
- Repoint metric-watcher's `reportApi.url` (helm value) to the dashboard ingest endpoint, replacing the SAM report API.

**CloudFront (`CloudFrontDistribution`) — declarative where possible.**
- Add `AWS::CloudFront::Function` (viewer-request Basic-Auth) associated with both behaviors, and an `AWS::CloudFront::ResponseHeadersPolicy` setting `Content-Security-Policy: frame-ancestors 'self'`.
- Add the `/dash/*` ordered cache behavior → dashboard ALB origin (CachingDisabled + AllViewer). Default `/*` stays → `workshop-origin` (terminal at root).

**ALB-origin sequencing (the wrinkle).** CloudFront is created at stack-create, but the dashboard ALB only exists after the phase-4 Ingress deploy, so its DNS cannot be a static `!GetAtt`. Recommended: in the RTBDash phase, after the Ingress provisions the ALB, discover its DNS (`kubectl get ingress` / `elbv2 describe-load-balancers`) and add the second origin + `/dash/*` behavior via `aws cloudfront get-distribution-config` + `update-distribution` — consistent with the template's existing imperative phases. Alternative: pre-create the ALB in CFN and bind pods via `TargetGroupBinding` so CloudFront can `!GetAtt` the DNS at create time (more declarative, more coupling).

**Terminal nginx (`TerminalSSMDocument` → `ConfigureNginx`).** Remove the `auth_basic` / `.htpasswd` block so the single edge gate isn't doubled. ttyd stays at root, no base-path change.

**Outputs.** Keep `RTBDashURL` (`/dash/`) and `TerminalURL` (`/`); remove `LoadGenApiNote` (references the retired `LambdaHelmStack`).

## Backend-Health Panel (Requirement 12)

The metric-watcher already polls bidder-side Prometheus metrics and pushes them to the (now retired) report API. We repoint it at the new service and surface the data as supporting context, clearly subordinate to the client-measured latency comparison (Requirement 12.2).

- **Repoint metric-watcher.** Set its `reportApi.url` to the dashboard service ingest endpoint (replacing the SAM report API). Its message shape is unchanged (`type: "metrics"`, `source: "metric-watcher"`, `rtb-env`).
- **Cross-cluster path.** metric-watcher runs on the DSP cluster; the dashboard runs on `cluster2-ssp`. So metric-watcher posts to the dashboard **ALB** ingest endpoint (token-gated), not in-cluster DNS. The load-generator (same cluster) keeps using in-cluster DNS. See Security for the ALB exposure controls.
- **Service routing.** Messages with `source: "metric-watcher"` are routed to a dedicated `backend-health` SSE event, kept separate from the `live-metrics` latency series so the two are never conflated.
- **Frontend.** A secondary, visually distinct strip shows bidder throughput, no-bid rate, processing time, and target up/down per environment — framed as "same backend across both paths." It reinforces that the data path is the only variable.
- **Not a prerequisite (Requirement 12.3).** If no metric-watcher data arrives, the strip shows an idle state; the core latency comparison is unaffected.

## Data Models (message schemas)

All messages carry `rtb-env` (`nlb` | `rtbfabric`) and flow `load-generator → POST /ingest → SSE`.

**Interval snapshot** (new, `type: "live-metrics"`):
```json
{
  "type": "live-metrics",
  "source": "load-generator",
  "rtb-env": "rtbfabric",
  "elapsed_seconds": 42,
  "window_seconds": 1,
  "latencies_ms": { "p50": 3.3, "p90": 4.5, "p95": 5.2, "p99": 10.3, "max": 21.0, "mean": 3.7 },
  "rate": 1000.0,
  "success": 0.9999,
  "status_codes": { "200": 812, "204": 188, "504": 0 },
  "buckets": { "2-3": 157, "3-4": 640, "4-5": 161 }
}
```

**Final report** (existing, unchanged passthrough): the load-generator's current report object with `type: "report"`, `source: "load-generator"`, `rtb-env`.

**Run-control request** (`POST /dash/run`):
```json
{ "mode": "both", "duration": "5m" }
```
`mode` is `nlb` | `rtbfabric` | `both`; `duration` is the only tunable parameter (default `5m`, clamped server-side). Rate, devices, and workers are fixed server constants and are not accepted from the client.

**SSE envelope** (service → browser): `{ "event": "live-metrics" | "report" | "readiness" | "run-state" | "backend-health", "data": { ... } }`.

**Readiness event**: `{ "nlb": "ready" | "not-ready", "rtbfabric": "ready" | "not-ready", "reasons": { "rtbfabric": "link not created" } }`.

## Security Design (priority #1)

- **Human access**: single CloudFront edge Basic-Auth gate over the whole distribution; no unauthenticated path reaches the shell (Requirement 9.1) and no redundant second login (9.7).
- **Terminal embedding**: `frame-ancestors 'self'` restricts framing to the dashboard origin (9.2); EC2 ingress stays CloudFront-only (9.5).
- **Machine ingestion**: `/ingest` is token-authenticated and not part of the public CloudFront human surface (CloudFront only maps `/dash/*`). The load-generator reaches it via in-cluster DNS; metric-watcher reaches it cross-cluster via the dashboard ALB. Restrict the ALB security group so `/dash/*` is reachable only from the CloudFront managed prefix list and `/ingest` only from the DSP cluster's source, preventing a direct-to-ALB bypass of the edge gate (9.3).
- **No client secrets**: the SPA bundle and its delivered config contain no API keys/long-lived secrets; the ingest token lives only in the service and the Job spec it creates (9.4).
- **Least privilege**: dashboard ServiceAccount RBAC limited to Job create/delete/list + pod read in one namespace; IRSA IAM limited to read-only `rtbfabric` (gateways/links) and `elasticloadbalancing:Describe*` for readiness and target resolution (4.7, 9.6). This is strictly less than the prior Lambda's broad EKS access.
- **Reduced surface**: retiring Cognito + WebSocket API + report Lambdas + DynamoDB + the load-gen Lambda removes several internet-facing/stateful components.

## Error Handling

- **Per-environment isolation**: a failure to launch or ingest one environment surfaces on that environment's panel and never presents a one-sided run as a complete comparison (Requirement 4.5); the other environment proceeds.
- **Interval emission failures**: logged by the load-generator; the run and subsequent emissions continue (1.6).
- **SSE reconnect**: `EventSource` auto-reconnects; snapshot-on-connect restores the in-progress view.
- **Readiness unknown**: controls fail safe to disabled (5.7).
- **Backpressure**: the load-generator tap is drop-if-full so streaming never throttles the attack.

## Testing Strategy

- **Load-generator**: unit-test the windowed aggregator (percentiles per window, reset semantics, elapsed calc) and that final-report output is unchanged when streaming is on/off.
- **Dashboard service**: unit-test ingest validation + `rtb-env` routing, SSE replay-on-connect, run-state guard; test Job templating and stop-by-label against a fake Kubernetes client; test readiness mapping (exports present/absent → ready/not-ready).
- **Frontend**: component tests for gating logic (disabled until ready) and chart data shaping (elapsed alignment, pinned axis, single-environment render).
- **End-to-end (manual, workshop)**: deploy, confirm readiness gating before/after link creation, run NLB-only, RTB-Fabric-only, and both; verify live charts, late-joiner replay, final-report reconciliation, embedded terminal, and single-URL access.

## Decisions (confirmed)

1. **`rtb-env` token** — standardized on **`nlb` / `rtbfabric`** (matches existing infra). ✔ Confirmed.
2. **Frontend framework** — **Svelte + Vite + uPlot**. ✔ Confirmed.
3. **Dashboard cluster placement** — **publisher/SSP cluster (`cluster2-ssp`)**, co-located with the load-generator for simplified reporting and cluster connectivity. ✔ Confirmed.
4. **Run control** — **in-cluster client-go Job creation**; retire the `load-gen-lambda` (`LambdaHelmStack`). ✔ Confirmed.
5. **Edge auth** — **CloudFront Function Basic-Auth**, nginx auth removed (single prompt). ✔ Confirmed.
6. **Backend-health panel (Requirement 12)** — **in scope.** metric-watcher already pushes bidder-side stats; repoint it at the new service and add a supporting (non-headline) panel. ✔ Confirmed.

### Remaining open item

- **Cross-cluster ingestion for backend-health.** metric-watcher runs on the DSP cluster while the dashboard runs on `cluster2-ssp`, so its posts are cross-cluster (see Backend-Health Panel and Security sections for the proposed ALB + token + security-group approach). Validate the chosen network path during implementation.
