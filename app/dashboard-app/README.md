# RTB Fabric Comparison Dashboard (frontend)

Svelte + Vite + uPlot single-page app for the live NLB-vs-RTB-Fabric latency
comparison. It is served under `/dash/` by the Go dashboard service
(`guidance-rtb/tools/rtb-dashboard`), which embeds this build output at image
build time.

## How it works

- Subscribes to `GET /dash/stream` (Server-Sent Events) for `live-metrics`,
  `report`, `readiness`, `run-state`, and `backend-health` events.
- Drives runs via `POST /dash/verify`, `/dash/run`, `/dash/stop`.
- Embeds the workshop terminal (ttyd at the distribution root) in an iframe.
- Contains no secrets or API keys — authentication is enforced at the
  CloudFront edge, and ingestion/control endpoints are same-origin.

## Develop

```bash
npm install
# Point the dev proxy at a running dashboard service (default localhost:8080):
DASH_DEV_BACKEND=http://localhost:8080 npm run dev
```

The app is served at `http://localhost:5173/dash/`. The embedded terminal
(`iframe src="/"`) only resolves behind the unified CloudFront distribution.

## Build / type-check

```bash
npm run build   # svelte-check + vite build -> dist/
npm run check   # type-check only
```

`vite build` emits to `dist/` with base `/dash/`; the service's container build
copies it into the embedded asset directory.
