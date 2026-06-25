# RTBDash

The frontend for the **RTB Fabric vs NLB live comparison dashboard** used in the
RTB Fabric workshop. It is a single-page app (Svelte + Vite + uPlot) that shows a
live, side-by-side latency comparison between the two connectivity paths to the
same bidder backend.

## Architecture

This repository contains only the frontend (`app/dashboard-app/`). It is built
into the Go **dashboard service** at container-image build time and served under
`/dash/` behind the workshop's CloudFront distribution:

```
browser ── CloudFront (edge Basic-Auth) ──> /dash/* ──> dashboard ALB (EKS)
                                                          └─ rtb-dashboard service (Go)
                                                             └─ embeds this SPA + SSE fan-out
```

- The SPA subscribes to `GET /dash/stream` (Server-Sent Events) and drives runs
  via `POST /dash/verify`, `/dash/run`, `/dash/stop`.
- The dashboard service lives in `guidance-rtb/tools/rtb-dashboard` and embeds
  the compiled `dist/` from `app/dashboard-app/` (see that repo's multi-stage
  `Dockerfile` and the `rtb-dashboard` Helm chart).
- Authentication is enforced once at the CloudFront edge; the bundle contains no
  secrets or API keys.

See `app/dashboard-app/README.md` for the frontend details.

## Legacy stack (retired)

The previous serverless stack — AWS SAM app (`dashboard-app`: API Gateway
WebSocket API, OnConnect/OnDisconnect/SendMessage Lambdas, Cognito user pool,
DynamoDB tables, report REST API) and the `load-gen-lambda` CDK stack
(`LambdaHelmStack`) — has been **removed**. Run control now happens in-cluster
(the dashboard service launches load-generator Jobs directly), live data streams
over SSE instead of WebSocket, and there is no Cognito/DynamoDB.

## Develop

```bash
cd app/dashboard-app
npm install
# Point the dev proxy at a running dashboard service (default localhost:8080):
DASH_DEV_BACKEND=http://localhost:8080 npm run dev   # http://localhost:5173/dash/
npm run build                                        # svelte-check + vite build -> dist/
npm test                                             # vitest (unit tests)
```

A cloud dev environment is described by `devfile.yaml` (install/build/test
commands).
