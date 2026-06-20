// Data layer: one EventSource feeds Svelte stores. High-rate live-metrics are
// kept in idempotent per-env ring buffers (keyed by elapsed seconds, so the
// server's snapshot-on-connect replay can be applied repeatedly across SSE
// reconnects without double-counting). Derived aggregates and chart data are
// recomputed at a throttled ~2 Hz cadence and exposed via getters so charts
// update on a `tick` rather than on every message (Requirements 2.2, 6.2, 7.6).

import { writable, derived, get, type Readable } from 'svelte/store'
import {
  ENVS,
  SSE_LIVE_METRICS,
  SSE_REPORT,
  SSE_READINESS,
  SSE_RUN_STATE,
  SSE_BACKEND_HEALTH,
  addBuckets,
  buildCdf,
  sampleCdf,
  unionSorted,
  durationToGo,
  FIXED_PARAMS,
  HIGH_LATENCY_MS,
  parseBucketBounds,
  type RtbEnv,
  type RunMode,
  type IntervalSnapshot,
  type ReadinessEvent,
  type RunState,
  type BackendHealthMessage,
  type LatencyPercentiles,
  type CdfCurve,
} from './contract'

const MAX_POINTS = 1200 // ~20 min at 1s; matches the service buffer cap
const FLUSH_MS = 500 // commit batched updates at ~2 Hz

// ---------------------------------------------------------------------------
// Reactive stores (subscribed by components).
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export const connection = writable<ConnectionState>('connecting')
export const readiness = writable<ReadinessEvent | null>(null)
export const runState = writable<RunState | null>(null)
export const backendHealth = writable<Partial<Record<RtbEnv, BackendHealthMessage>>>({})
export const finals = writable<Partial<Record<RtbEnv, unknown>>>({})

/** Latest interval snapshot per environment, committed at flush cadence. */
export const latest = writable<Partial<Record<RtbEnv, IntervalSnapshot>>>({})

/** Bumped on each batched flush; chart components subscribe and re-read getters. */
export const tick = writable(0)

/** In-flight control action, used to disable buttons and show progress. */
export const busy = writable<'verify' | 'run' | 'stop' | null>(null)
export const actionError = writable<string | null>(null)

/** True while any environment is actively running. */
export const isRunning: Readable<boolean> = derived(runState, ($rs) => {
  if (!$rs) return false
  return Object.values($rs.environments).some((e) => e.status === 'running')
})

// ---------------------------------------------------------------------------
// Non-reactive internal buffers (idempotent; recomputed into caches on flush).
// ---------------------------------------------------------------------------

const intervals: Record<RtbEnv, Map<number, IntervalSnapshot>> = {
  nlb: new Map(),
  rtbfabric: new Map(),
}

interface EnvCache {
  sorted: IntervalSnapshot[]
  buckets: Record<string, number>
  statusTotals: Record<string, number>
  runMax: number
}

function emptyCache(): EnvCache {
  return { sorted: [], buckets: {}, statusTotals: {}, runMax: 0 }
}

const cache: Record<RtbEnv, EnvCache> = {
  nlb: emptyCache(),
  rtbfabric: emptyCache(),
}

let lastRunID: string | null = null
let dirty = false
let lastFlush = 0
let rafHandle: number | null = null

// ---------------------------------------------------------------------------
// Ingest + flush.
// ---------------------------------------------------------------------------

function ingestInterval(snap: IntervalSnapshot): void {
  const env = snap['rtb-env']
  const buf = intervals[env]
  if (!buf) return
  buf.set(snap.elapsed_seconds, snap)
  // Bound memory: drop the oldest elapsed-second keys beyond the cap.
  if (buf.size > MAX_POINTS) {
    const keys = Array.from(buf.keys()).sort((a, b) => a - b)
    for (let i = 0; i < buf.size - MAX_POINTS; i++) buf.delete(keys[i])
  }
  dirty = true
}

function clearRun(): void {
  for (const env of ENVS) {
    intervals[env].clear()
    cache[env] = emptyCache()
  }
  latest.set({})
  finals.set({})
  dirty = true
}

/** Recomputes per-env caches from the idempotent interval buffers. */
function recompute(): void {
  const nextLatest: Partial<Record<RtbEnv, IntervalSnapshot>> = {}
  for (const env of ENVS) {
    const sorted = Array.from(intervals[env].values()).sort(
      (a, b) => a.elapsed_seconds - b.elapsed_seconds,
    )
    const buckets: Record<string, number> = {}
    const statusTotals: Record<string, number> = {}
    let runMax = 0
    for (const s of sorted) {
      addBuckets(buckets, s.buckets)
      for (const [code, n] of Object.entries(s.status_codes)) {
        statusTotals[code] = (statusTotals[code] ?? 0) + n
      }
      if (s.latencies_ms.max > runMax) runMax = s.latencies_ms.max
    }
    cache[env] = { sorted, buckets, statusTotals, runMax }
    if (sorted.length > 0) nextLatest[env] = sorted[sorted.length - 1]
  }
  latest.set(nextLatest)
}

function flush(): void {
  if (dirty) {
    recompute()
    tick.update((n) => n + 1)
    dirty = false
  }
  lastFlush = performance.now()
}

function scheduleFlushLoop(): void {
  if (rafHandle !== null) return
  const loop = () => {
    if (dirty && performance.now() - lastFlush >= FLUSH_MS) flush()
    rafHandle = requestAnimationFrame(loop)
  }
  rafHandle = requestAnimationFrame(loop)
}

function stopFlushLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle)
    rafHandle = null
  }
}

// ---------------------------------------------------------------------------
// SSE connection.
// ---------------------------------------------------------------------------

const apiPath = (p: string): string => `${import.meta.env.BASE_URL}${p}`

let source: EventSource | null = null

export function connectStream(): void {
  if (source) return
  scheduleFlushLoop()

  const es = new EventSource(apiPath('stream'))
  source = es

  es.onopen = () => connection.set('open')
  es.onerror = () => connection.set('reconnecting') // EventSource auto-retries

  es.addEventListener(SSE_LIVE_METRICS, (e) => {
    const snap = safeParse<IntervalSnapshot>((e as MessageEvent).data)
    if (snap) ingestInterval(snap)
  })

  es.addEventListener(SSE_RUN_STATE, (e) => {
    const state = safeParse<RunState>((e as MessageEvent).data)
    if (!state) return
    if (state.run_id && state.run_id !== lastRunID) {
      lastRunID = state.run_id
      clearRun()
    }
    runState.set(state)
  })

  es.addEventListener(SSE_READINESS, (e) => {
    const r = safeParse<ReadinessEvent>((e as MessageEvent).data)
    if (r) readiness.set(r)
  })

  es.addEventListener(SSE_REPORT, (e) => {
    const report = safeParse<{ 'rtb-env'?: RtbEnv }>((e as MessageEvent).data)
    if (report && report['rtb-env']) {
      finals.update((f) => ({ ...f, [report['rtb-env'] as RtbEnv]: report }))
    }
  })

  es.addEventListener(SSE_BACKEND_HEALTH, (e) => {
    const msg = safeParse<BackendHealthMessage>((e as MessageEvent).data)
    if (msg && msg['rtb-env']) {
      backendHealth.update((b) => ({ ...b, [msg['rtb-env']]: msg }))
    }
  })
}

export function disconnectStream(): void {
  if (source) {
    source.close()
    source = null
  }
  stopFlushLoop()
}

function safeParse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Control API (verify / run / stop).
// ---------------------------------------------------------------------------

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(apiPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function verify(): Promise<void> {
  busy.set('verify')
  actionError.set(null)
  try {
    const res = await post('verify')
    if (!res.ok) throw new Error(await errorText(res, 'Verification failed'))
    const r = (await res.json()) as ReadinessEvent
    readiness.set(r) // SSE also broadcasts this; setting here is immediate
  } catch (err) {
    actionError.set(messageOf(err))
  } finally {
    busy.set(null)
  }
}

export async function runTest(mode: RunMode, durationSeconds: number): Promise<void> {
  busy.set('run')
  actionError.set(null)
  try {
    const res = await post('run', { mode, duration: durationToGo(durationSeconds) })
    if (!res.ok) throw new Error(await errorText(res, 'Failed to start run'))
    const state = (await res.json()) as RunState
    if (state.run_id && state.run_id !== lastRunID) {
      lastRunID = state.run_id
      clearRun()
    }
    runState.set(state)
  } catch (err) {
    actionError.set(messageOf(err))
  } finally {
    busy.set(null)
  }
}

export async function stopTest(mode?: RunMode): Promise<void> {
  busy.set('stop')
  actionError.set(null)
  try {
    const res = await post('stop', mode ? { mode } : {})
    if (!res.ok) throw new Error(await errorText(res, 'Failed to stop run'))
  } catch (err) {
    actionError.set(messageOf(err))
  } finally {
    busy.set(null)
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.text()).trim()
  return body || `${fallback} (HTTP ${res.status})`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Derived data getters (read after each `tick`).
// ---------------------------------------------------------------------------

export interface SeriesData {
  x: number[]
  series: Record<RtbEnv, (number | null)[]>
}

/**
 * Builds an elapsed-time-aligned series for a latency percentile across both
 * environments. Both envs share one x axis (union of elapsed seconds), with
 * null gaps where an env has no sample — so they overlay correctly
 * (Requirements 2.2, 2.3).
 */
export function getLatencySeries(metric: keyof LatencyPercentiles): SeriesData {
  const x = unionSorted(
    cache.nlb.sorted.map((s) => s.elapsed_seconds),
    cache.rtbfabric.sorted.map((s) => s.elapsed_seconds),
  )
  const series = {} as Record<RtbEnv, (number | null)[]>
  for (const env of ENVS) {
    const byElapsed = new Map<number, number>()
    for (const s of cache[env].sorted) byElapsed.set(s.elapsed_seconds, s.latencies_ms[metric])
    series[env] = x.map((t) => byElapsed.get(t) ?? null)
  }
  return { x, series }
}

/** Builds overlaid CDF curves for both environments sampled onto a shared x grid. */
export function getCdfData(): SeriesData {
  const curves: Record<RtbEnv, CdfCurve> = {
    nlb: buildCdf(cache.nlb.buckets),
    rtbfabric: buildCdf(cache.rtbfabric.buckets),
  }
  const x = unionSorted(curves.nlb.x, curves.rtbfabric.x)
  const series = {} as Record<RtbEnv, (number | null)[]>
  for (const env of ENVS) series[env] = sampleCdf(curves[env], x)
  return { x, series }
}

export interface TailStats {
  hasData: boolean
  errors: number // non-2xx/3xx responses
  timeouts: number // HTTP 504
  overThreshold: number // requests with latency >= HIGH_LATENCY_MS
  max: number // max latency seen this run (ms)
}

export function getTailStats(env: RtbEnv): TailStats {
  const c = cache[env]
  let errors = 0
  let timeouts = 0
  for (const [code, n] of Object.entries(c.statusTotals)) {
    const num = Number(code)
    if (num === 504) timeouts += n
    if (num >= 400 || num === 0) errors += n
  }
  let overThreshold = 0
  for (const [key, n] of Object.entries(c.buckets)) {
    if (parseBucketBounds(key).lo >= HIGH_LATENCY_MS) overThreshold += n
  }
  return {
    hasData: c.sorted.length > 0,
    errors,
    timeouts,
    overThreshold,
    max: c.runMax,
  }
}

export function hasAnyData(): boolean {
  return cache.nlb.sorted.length > 0 || cache.rtbfabric.sorted.length > 0
}

/** The achieved request rate from the latest snapshots, falling back to the fixed target. */
export function currentRate(): number {
  const l = get(latest)
  const rates = ENVS.map((e) => l[e]?.rate).filter((r): r is number => typeof r === 'number')
  if (rates.length === 0) return FIXED_PARAMS.rate
  return Math.max(...rates)
}
