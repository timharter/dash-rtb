import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The dashboard is served by the Go service under /dash/ and embedded into the
// binary at build time, so the production build must use base '/dash/'.
//
// For local development, point the dev server at a running dashboard service
// with DASH_DEV_BACKEND (default http://localhost:8080) so the SSE stream and
// control endpoints work without CloudFront. The embedded terminal (iframe
// src="/") only resolves behind the unified CloudFront distribution.
const backend = process.env.DASH_DEV_BACKEND || 'http://localhost:8080'

export default defineConfig({
  base: '/dash/',
  plugins: [svelte()],
  server: {
    proxy: {
      '/dash/stream': { target: backend, changeOrigin: true },
      '/dash/verify': { target: backend, changeOrigin: true },
      '/dash/run': { target: backend, changeOrigin: true },
      '/dash/stop': { target: backend, changeOrigin: true },
      '/ingest': { target: backend, changeOrigin: true },
      '/healthz': { target: backend, changeOrigin: true },
    },
  },
})
