# Implementation Plan

This plan spans three repos (`guidance-rtb`, `dash-rtb`, `rtb-fabric-workshop`). Build order: shared message contract → load-generator streaming → dashboard service → frontend → packaging/build → workshop template wiring → legacy retirement → end-to-end verification. Targeted unit tests are embedded where the design's Testing Strategy calls for them (highest-risk pure logic).

- [x] 1. Lock the shared message contract
  - Define the interval snapshot (`type: "live-metrics"`), the SSE envelope (`live-metrics | report | readiness | run-state | backend-health`), the run-control request (`{ mode, duration }`), and the readiness payload as the contract used by both the load-generator and the dashboard service.
  - Capture them as Go structs in the load-generator and mirror them in the service so both serialize identically.
  - _Requirements: 1.3, 2.4, 3.2_

- [x] 2. Load-generator: windowed metrics aggregator (`guidance-rtb`)
  - [x] 2.1 Implement a tumbling-window aggregator: per-window t-digest for p50/p90/p95/p99, plus max, mean, request/success counts, per-status-code counts, and histogram-bucket counts reusing the existing `Histogram` buckets.
    - Unit-test percentile computation, per-window reset semantics, and elapsed-seconds calculation.
    - _Requirements: 1.2, 2.5_
  - [x] 2.2 Add a non-blocking tap from the attack hot path (`hit()` → bounded channel, drop-if-full) feeding the aggregator; verify it never throttles the attack.
    - _Requirements: 1.6_

- [x] 3. Load-generator: interval emitter + wiring (`guidance-rtb`)
  - [x] 3.1 Add a `SendInterval` method to the report client that POSTs the live-metrics message (tagged with `rtb-env`).
    - _Requirements: 1.1, 1.3_
  - [x] 3.2 Add a `--report-interval` flag (default `1s`); start the emitter goroutine before `Attack` and stop it after; emit only when the report API is configured; log-and-continue on emit failure.
    - _Requirements: 1.1, 1.6, 1.7_
  - [x] 3.3 Leave the final-report path unchanged; unit-test that final output is byte-identical with streaming on and off.
    - _Requirements: 1.4, 1.5_
  - Note: ships through the existing `buildspec-wss-loadgen.yml` image — no new build needed for the load-generator.

- [x] 4. Dashboard service: scaffold (`guidance-rtb`, Go)
  - Create the Go module/binary (ARM64), config via flags/env, `GET /healthz`, and embedded static-asset serving under `/dash/`.
  - _Requirements: 3.4, 3.5_

- [x] 5. Dashboard service: ingestion + routing
  - Implement `POST /ingest` with shared-token auth; accept live-metrics, final reports, and metric-watcher messages; validate and route by `rtb-env` + `source`; reject unknown messages with a logged warning without disrupting other clients.
  - Unit-test routing and rejection paths.
  - _Requirements: 3.1, 3.2, 3.3, 12.1_

- [x] 6. Dashboard service: in-memory run state + SSE fan-out
  - Implement per-run bounded buffers (interval snapshots per env, finals, completion flags, cached readiness); `GET /dash/stream` SSE with snapshot-on-connect then deltas; subscriber registry with disconnect cleanup; retain the last completed run.
  - Unit-test replay-on-connect and bounded-buffer behavior.
  - _Requirements: 3.2, 3.7, 6.1, 6.2, 6.3, 6.4_

- [x] 7. Dashboard service: on-demand verification
  - Implement `POST /dash/verify`: rtbfabric gateway + link `ACTIVE` check and elbv2 `rtb-bidder-external` check; resolve the per-env target URLs; cache the result; emit a `readiness` SSE event; apply a short min-interval guard; fail-safe to not-ready with reasons. No timed polling.
  - Unit-test readiness mapping (active/missing → ready/not-ready) and target resolution against a fake AWS client.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8_

- [x] 8. Dashboard service: run control
  - Implement `POST /dash/run` (mode `nlb` | `rtbfabric` | `both`; duration validated/clamped; rate/devices/workers fixed server-side) creating load-generator Job(s) via client-go, re-resolving targets at launch and setting `--report-api-url` to the in-cluster `/ingest`; `POST /dash/stop` deletes Jobs by label; run-in-progress guard; per-environment launch-failure surfaced (never a one-sided "complete" comparison).
  - Unit-test job templating, duration clamp, stop-by-label, and partial-failure handling with a fake Kubernetes client.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

- [x] 9. Frontend: scaffold + data layer (`dash-rtb`, Svelte + Vite + uPlot)
  - Rebuild the app under base `/dash/`; wire `EventSource('/dash/stream')` into a store; per-env ring buffers keyed by elapsed seconds; batch chart updates (~1–2 Hz / rAF); define consistent per-env color + line-style tokens.
  - _Requirements: 2.2, 6.2, 7.6, 7.7_

- [x] 10. Frontend: verify + run controls
  - "Verify configuration" button → `POST /dash/verify`; per-env gating driven by cached readiness (restored via SSE snapshot, persists across reloads); mode selector + duration slider (default 5m, bounded) + Run/Stop; fixed params shown read-only; disabled-state tooltips explaining what is pending.
  - _Requirements: 4.1, 4.9, 4.10, 5.1, 5.3, 5.4, 5.5, 5.6_

- [x] 11. Frontend: comparison panels
  - KPI tiles (p99/p50/mean/throughput/error + delta); live latency time-series (uPlot, p99 default with p50/p95 toggle, elapsed x-axis, pinned y-axis); CDF from windowed buckets; tail/reliability panel; prominent fixed-rate display; clean single-environment and idle states.
  - _Requirements: 2.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.8, 7.9_

- [x] 12. Frontend: backend-health strip + embedded terminal
  - [x] 12.1 Backend-health strip fed by `backend-health` SSE events (bidder throughput, no-bid rate, processing time, target up/down), visually distinct and secondary to the latency comparison; idle state when no metric-watcher data.
    - _Requirements: 12.1, 12.2, 12.3_
  - [x] 12.2 Resizable CloudShell-style terminal panel: a toggle that opens `<iframe src="/">` (the root-served ttyd) and reflows on resize.
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

- [x] 13. Packaging: image + build pipeline (`guidance-rtb`)
  - [x] 13.1 Multi-stage `Dockerfile` (stage 1 Vite frontend build → stage 2 Go build embedding the assets → Alpine/ARM64 final) + `Makefile` targets `rtb-dashboard@build` / `@push`.
    - _Requirements: 11.1_
  - [x] 13.2 `buildspec-rtb-dashboard.yml` + `build-rtb-dashboard.sh` (ensure ECR repo, build, push), mirroring the metric-watcher pattern.
    - _Requirements: 11.2, 11.3_

- [x] 14. Packaging: Helm chart (`guidance-rtb`)
  - Add the `rtb-dashboard` chart: Deployment (1 replica), Service, Ingress/ALB, ServiceAccount + Role/RoleBinding (`batch/jobs` create/delete/list/watch, `pods` get/list), IRSA annotation (read-only `rtbfabric` + `elasticloadbalancing:Describe*`), and values (image, ingest token, namespace, verify min-interval).
  - _Requirements: 4.7, 9.6, 11.4_

- [x] 15. Workshop template: CloudFront unification (`rtb-fabric-workshop`)
  - [x] 15.1 Add `AWS::CloudFront::Function` (viewer-request Basic-Auth) and `AWS::CloudFront::ResponseHeadersPolicy` (`frame-ancestors 'self'`); associate with the behaviors.
    - _Requirements: 9.1, 9.2, 9.7_
  - [x] 15.2 Add the imperative ALB-origin step in the RTBDash phase: discover the dashboard ALB DNS, then add the `dashboard-origin` + `/dash/*` ordered behavior via `aws cloudfront update-distribution`.
    - _Requirements: 8.1, 8.2, 8.4_
  - [x] 15.3 Remove the nginx `auth_basic`/`.htpasswd` block in `ConfigureNginx`; drop the `LoadGenApiNote` output.
    - _Requirements: 9.7, 11.6_

- [x] 16. Workshop template: deploy-phase rewrite (`rtb-fabric-workshop`)
  - [x] 16.1 Add a `start-build` for `buildspec-rtb-dashboard.yml` (project `rtb-build-project`) in `StartContainerImageBuilds`, recording its build id for the build barrier.
    - _Requirements: 11.2, 11.3_
  - [x] 16.2 Replace the SAM/Lambda steps with `helm upgrade --install rtb-dashboard` onto `cluster2-ssp`; remove `StartSAMDeploy`, `DeployLoadGenLambda`, and `WaitForSAMAndPatchReportApi`.
    - _Requirements: 11.6, 11.7_
  - [x] 16.3 Repoint metric-watcher's `reportApi.url` (helm value) to the dashboard ingest endpoint with the ingest token; restrict the dashboard ALB security group (CloudFront prefix list for `/dash/*`; DSP-cluster source for `/ingest`).
    - _Requirements: 9.3, 9.5, 12.1_

- [x] 17. Retire the legacy stack (`dash-rtb`)
  - Remove the SAM app (Cognito, WebSocket API, OnConnect/OnDisconnect/SendMessage + report Lambdas, DynamoDB tables) and the `load-gen-lambda`; remove the old React app, replaced by the rebuilt frontend.
  - _Requirements: 11.6_

- [ ] 18. End-to-end verification (manual)
  - Deploy via the template and confirm: controls gated until Verify; Verify both before and after RTB Fabric link creation; run NLB-only, RTB-Fabric-only, and both (simultaneous); live latency / CDF / KPI / tail panels; late-joiner SSE replay; live-vs-final reconciliation; backend-health strip; embedded resizable terminal; single CloudFront URL; and zero rtbfabric API calls while idle.
  - _Requirements: all_
