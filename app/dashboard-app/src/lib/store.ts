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
  SSE_CONFIG,
  addBuckets,
  buildCdf,
  sampleCdf,
  unionSorted,
  durationToGo,
  FIXED_PARAMS,
  HIGH_LATENCY_MS,
  parseBucketBounds,
  nsToMs,
  type RtbEnv,
  type RunMode,
  type IntervalSnapshot,
  type CompletionReport,
  type KpiSnapshot,
  type ReadinessEvent,
  type RunState,
  type BackendHealthMessage,
  type LatencyPercentiles,
  type CdfCurve,
  type FixedParams,
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
export const finals = writable<Partial<Record<RtbEnv, CompletionReport>>>({})

// Bidder Prometheus counters are monotonic (cumulative since pod start), so the
// raw totals only ever grow across runs. We snapshot them when a run starts and
// BackendHealth renders current − baseline — i.e. activity for the current run,
// the same idea as Prometheus increase()/rate() — without mutating the counters
// (resetting a counter would break rate()/Grafana and needs a pod restart).
export const healthBaseline = writable<Record<string, number> | null>(null)

// Auto-trials: per-environment summaries accumulated across a sequence of runs,
// plus the orchestration state. Used to show mean ± std dev so run-to-run
// variance is visible (the representative comparison). Orchestration lives in
// the control API section below.
export interface TrialSummary {
  p50: number
  p90: number
  p95: number
  p99: number
  mean: number
  success: number
  throughput: number
}

export interface TrialState {
  active: boolean
  total: number
  completed: number
  durationSec: number
  phase: 'running' | 'done' | 'stopped' | 'error'
}

/** Default auto-trial config: 5 simultaneous runs of 2 minutes each. */
export const TRIAL_COUNT = 5
export const TRIAL_DURATION_SEC = 120

// Trials accumulate entirely client-side — the hub tracks individual runs, not
// the multi-run aggregate — so unlike the charts they have nothing to replay
// from the server on reload. We persist them to sessionStorage and rehydrate on
// load so a refresh keeps the results table. sessionStorage (not localStorage)
// scopes them to the tab/session: a reload keeps them, closing the tab clears
// them.
const TRIALS_KEY = 'rtb-dash.trials.v1'

interface PersistedTrials {
  trials: Record<RtbEnv, TrialSummary[]>
  autoTrials: TrialState | null
}

function loadPersistedTrials(): PersistedTrials | null {
  try {
    const raw = sessionStorage.getItem(TRIALS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PersistedTrials
    const t = p.trials
    return {
      trials: {
        nlb: Array.isArray(t?.nlb) ? t.nlb : [],
        rtbfabric: Array.isArray(t?.rtbfabric) ? t.rtbfabric : [],
      },
      // A sequence that was mid-flight cannot resume after reload — its
      // client-side orchestration (timers, current run id) is gone — so restore
      // it as inactive rather than pretending it is still running.
      autoTrials: p.autoTrials
        ? {
            ...p.autoTrials,
            active: false,
            phase: p.autoTrials.active ? 'stopped' : p.autoTrials.phase,
          }
        : null,
    }
  } catch {
    return null
  }
}

const persistedTrials = typeof sessionStorage !== 'undefined' ? loadPersistedTrials() : null

export const trials = writable<Record<RtbEnv, TrialSummary[]>>(
  persistedTrials?.trials ?? { nlb: [], rtbfabric: [] },
)
export const autoTrials = writable<TrialState | null>(persistedTrials?.autoTrials ?? null)

/** Persists the trial results + orchestration state so a reload keeps them. */
function persistTrials(): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    const payload: PersistedTrials = { trials: get(trials), autoTrials: get(autoTrials) }
    sessionStorage.setItem(TRIALS_KEY, JSON.stringify(payload))
  } catch {
    // storage unavailable or over quota — non-fatal; trials just won't persist.
  }
}

// Persist on every change. The immediate fire on subscribe re-saves the
// rehydrated value, which is harmless.
trials.subscribe(persistTrials)
autoTrials.subscribe(persistTrials)

/**
 * Server-side fixed load parameters (rate/devices/workers). Seeded with the
 * compiled-in defaults and overwritten by the backend's `config` SSE event,
 * which is replayed first on connect — so the UI always reflects the values the
 * dashboard actually launches jobs with.
 */
export const fixedParams = writable<FixedParams>({ ...FIXED_PARAMS })

/** Latest interval snapshot per environment, committed at flush cadence. */
export const latest = writable<Partial<Record<RtbEnv, IntervalSnapshot>>>({})

/** Bumped on each batched flush; chart components subscribe and re-read getters. */
export const tick = writable(0)

/** In-flight control action, used to disable buttons and show progress. */
export const busy = writable<'verify' | 'run' | 'stop' | null>(null)
export const actionError = writable<string | null>(null)

/** Whether the CloudShell-style terminal overlay is open. UI-only state. */
export const terminalOpen = writable(false)

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
// When a run starts before any bidder-health sample has arrived, defer baseline
// capture to the first subsequent backend-health message (see connectStream).
let awaitingBaseline = false
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

function envsForMode(mode: string): RtbEnv[] {
  if (mode === 'nlb') return ['nlb']
  if (mode === 'rtbfabric') return ['rtbfabric']
  return [...ENVS] // "both" or unknown -> clear all
}

/**
 * Clears only the given environments' buffers and derived state, leaving the
 * others intact. Re-running one path (e.g. RTB Fabric) therefore resets just
 * that path's visuals while the other path's last run stays on screen for
 * comparison; the backend retains the other path too, so a reconnect replays
 * both. A simultaneous ("both") run passes every environment and clears all.
 */
function clearEnvs(envs: RtbEnv[]): void {
  for (const env of envs) {
    intervals[env].clear()
    cache[env] = emptyCache()
  }
  latest.update((l) => {
    const next = { ...l }
    for (const env of envs) delete next[env]
    return next
  })
  finals.update((f) => {
    const next = { ...f }
    for (const env of envs) delete next[env]
    return next
  })
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
      clearEnvs(envsForMode(state.mode))
      captureHealthBaseline()
    }
    runState.set(state)
    maybeAdvanceTrials()
  })

  es.addEventListener(SSE_READINESS, (e) => {
    const r = safeParse<ReadinessEvent>((e as MessageEvent).data)
    if (r) readiness.set(r)
  })

  es.addEventListener(SSE_REPORT, (e) => {
    const report = safeParse<CompletionReport>((e as MessageEvent).data)
    if (report && report['rtb-env']) {
      finals.update((f) => ({ ...f, [report['rtb-env'] as RtbEnv]: report }))
      maybeAdvanceTrials()
    }
  })

  es.addEventListener(SSE_BACKEND_HEALTH, (e) => {
    const msg = safeParse<BackendHealthMessage>((e as MessageEvent).data)
    if (msg && msg['rtb-env']) {
      backendHealth.update((b) => ({ ...b, [msg['rtb-env']]: msg }))
      if (awaitingBaseline) {
        healthBaseline.set({ ...msg.metrics })
        awaitingBaseline = false
      }
    }
  })

  es.addEventListener(SSE_CONFIG, (e) => {
    const cfg = safeParse<Partial<FixedParams>>((e as MessageEvent).data)
    if (cfg) {
      fixedParams.update((prev) => ({
        rate: typeof cfg.rate === 'number' ? cfg.rate : prev.rate,
        devices: typeof cfg.devices === 'number' ? cfg.devices : prev.devices,
        workers: typeof cfg.workers === 'number' ? cfg.workers : prev.workers,
      }))
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

/** Most recent bidder-health sample across environments (metric-watcher reports
 *  bidder-wide totals, tagged per env; the newest one wins). */
function latestHealth(): BackendHealthMessage | null {
  const bh = get(backendHealth)
  const msgs = ENVS.map((e) => bh[e]).filter((m): m is BackendHealthMessage => Boolean(m))
  if (msgs.length === 0) return null
  return msgs.reduce((a, b) => ((a.timestamp ?? '') >= (b.timestamp ?? '') ? a : b))
}

/**
 * Snapshots the bidder counters as the per-run zero point. Uses the latest
 * pre-run sample when available; otherwise defers to the first backend-health
 * message after the run starts (awaitingBaseline).
 */
function captureHealthBaseline(): void {
  const latest = latestHealth()
  if (latest) {
    healthBaseline.set({ ...latest.metrics })
    awaitingBaseline = false
  } else {
    healthBaseline.set(null)
    awaitingBaseline = true
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
      clearEnvs(envsForMode(state.mode))
      captureHealthBaseline()
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
// Auto-trials: run N simultaneous trials back-to-back and accumulate per-env
// summary stats, so the UI can show mean ± std dev across runs. Orchestrated
// client-side by reusing /dash/run; a trial is recorded when both environments
// of the current run complete and their reports are in.
// ---------------------------------------------------------------------------

let autoCurrentRunId: string | null = null
let autoRecordedRunId: string | null = null

function summarize(r: CompletionReport): TrialSummary {
  return {
    p50: nsToMs(r.latencies['50th']),
    p90: nsToMs(r.latencies['90th']),
    p95: nsToMs(r.latencies['95th']),
    p99: nsToMs(r.latencies['99th']),
    mean: nsToMs(r.latencies.mean),
    success: r.success,
    throughput: r.throughput,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True when a run-state reflects a launch rejected because the previous run's
 *  jobs are still present (the "a run is already in progress" guard). */
function launchBlocked(s: RunState): boolean {
  return ENVS.some(
    (e) => s.environments[e]?.status === 'failed' && /in progress/i.test(s.environments[e]?.error ?? ''),
  )
}

/**
 * Starts the next trial. A just-finished load-generator job stays "active" for
 * a few seconds after it reports, so back-to-back launches can hit the backend
 * "run already in progress" guard. We let the previous job finish (settleFirst)
 * and retry while a launch is still blocked, rather than failing the sequence.
 */
async function startNextTrial(durationSec: number, settleFirst: boolean): Promise<void> {
  actionError.set(null)
  try {
    if (settleFirst) await delay(6000) // let the previous trial's job finish
    for (let attempt = 0; ; attempt++) {
      if (!get(autoTrials)?.active) return
      const res = await post('run', { mode: 'both', duration: durationToGo(durationSec) })
      if (!res.ok) throw new Error(await errorText(res, 'Failed to start trial'))
      const state = (await res.json()) as RunState
      if (!launchBlocked(state)) {
        autoCurrentRunId = state.run_id
        if (state.run_id && state.run_id !== lastRunID) {
          lastRunID = state.run_id
          clearEnvs(envsForMode(state.mode))
          captureHealthBaseline()
        }
        runState.set(state)
        return
      }
      if (attempt >= 4) {
        throw new Error('previous run is still terminating — could not start the next trial')
      }
      await delay(5000) // wait for k8s to finish tearing the previous job down
    }
  } catch (err) {
    actionError.set(messageOf(err))
    autoTrials.update((a) => (a ? { ...a, active: false, phase: 'error' } : a))
  }
}

export async function startAutoTrials(
  count = TRIAL_COUNT,
  durationSec = TRIAL_DURATION_SEC,
): Promise<void> {
  trials.set({ nlb: [], rtbfabric: [] })
  autoCurrentRunId = null
  autoRecordedRunId = null
  autoTrials.set({ active: true, total: count, completed: 0, durationSec, phase: 'running' })
  await startNextTrial(durationSec, false)
}

export async function stopAutoTrials(): Promise<void> {
  autoTrials.update((a) => (a ? { ...a, active: false, phase: 'stopped' } : a))
  await stopTest('both')
}

export function clearTrials(): void {
  trials.set({ nlb: [], rtbfabric: [] })
  autoTrials.set(null)
  autoCurrentRunId = null
  autoRecordedRunId = null
}

/**
 * Records the current auto-trial and launches the next when both environments
 * of the current run are complete and both reports have arrived. Idempotent per
 * run via autoRecordedRunId. Called from the run-state and report SSE handlers.
 */
function maybeAdvanceTrials(): void {
  const a = get(autoTrials)
  if (!a || !a.active || !autoCurrentRunId) return
  const state = get(runState)
  if (!state || state.run_id !== autoCurrentRunId || state.run_id === autoRecordedRunId) return
  if (!ENVS.every((e) => state.environments[e]?.status === 'complete')) return
  const f = get(finals)
  if (!ENVS.every((e) => f[e])) return // wait until both reports are in

  autoRecordedRunId = state.run_id
  trials.update((t) => ({
    nlb: [...t.nlb, summarize(f.nlb as CompletionReport)],
    rtbfabric: [...t.rtbfabric, summarize(f.rtbfabric as CompletionReport)],
  }))

  const completed = a.completed + 1
  if (completed < a.total) {
    autoTrials.set({ ...a, completed })
    void startNextTrial(a.durationSec, true)
  } else {
    autoTrials.set({ ...a, completed, active: false, phase: 'done' })
  }
}

/** Arithmetic mean of a sample. */
export function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}

/** Sample standard deviation (n-1); 0 for fewer than two samples. */
export function stdDevOf(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = meanOf(xs)
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
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

/** Inverse-CDF: the latency (ms) under which `p` percent of requests fall,
 * linearly interpolated between the curve's points. Returns null when `p`
 * exceeds the highest cumulative percentage the curve reaches (a long tail kept
 * only in the open-ended overflow bucket). */
function latencyAtPercentile(curve: CdfCurve, p: number): number | null {
  const { x, y } = curve
  if (x.length === 0) return null
  if (p <= y[0]) return x[0]
  for (let i = 1; i < y.length; i++) {
    if (y[i] >= p) {
      const y0 = y[i - 1]
      const y1 = y[i]
      if (y1 <= y0) return x[i]
      const t = (p - y0) / (y1 - y0)
      return x[i - 1] + t * (x[i] - x[i - 1])
    }
  }
  return null
}

/** Maximum "nines" plotted on the percentile axis: 3 => up to the 99.9th. */
export const PCTL_MAX_NINES = 3
const PCTL_SAMPLES = 64

/** The percentile (0..100) for a transformed-axis value xt = -log10(1 - p/100). */
export function percentileForAxis(xt: number): number {
  return 100 * (1 - Math.pow(10, -xt))
}

export interface PercentileData {
  /** Transformed-percentile axis (evenly spaced "nines" so the tail is legible). */
  xt: number[]
  series: Record<RtbEnv, (number | null)[]>
}

/**
 * Builds latency-by-percentile curves for both environments on a tail-emphasizing
 * axis. y is the latency under which p% of requests fall, so a curve that climbs
 * toward the right exposes the tail — the NLB-vs-Fabric differentiator that a
 * linear CDF squashes against 100% (Requirement 7.3).
 */
export function getPercentileData(): PercentileData {
  const curves: Record<RtbEnv, CdfCurve> = {
    nlb: buildCdf(cache.nlb.buckets),
    rtbfabric: buildCdf(cache.rtbfabric.buckets),
  }
  const xt: number[] = []
  for (let i = 0; i <= PCTL_SAMPLES; i++) xt.push((i / PCTL_SAMPLES) * PCTL_MAX_NINES)

  const series = {} as Record<RtbEnv, (number | null)[]>
  for (const env of ENVS) {
    series[env] = xt.map((t) => latencyAtPercentile(curves[env], percentileForAxis(t)))
  }
  return { xt, series }
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

// ---------------------------------------------------------------------------
// Authoritative end-of-run selection. While an environment is still running we
// show the latest live window; once it completes we switch to its completion
// report, which is the whole-run aggregate. This fixes the end-of-test skew
// where the final partial live window (a short, dead-time-padded window) became
// the KPI source and collapsed throughput. The report is also a single discrete
// per-env payload, so it is unaffected by any live-buffer accumulation quirks.
// ---------------------------------------------------------------------------

function isComplete($rs: RunState | null, env: RtbEnv): boolean {
  return $rs?.environments?.[env]?.status === 'complete'
}

/** KPI values from a completion report (latencies are ns in the report). */
function kpiFromReport(r: CompletionReport): KpiSnapshot {
  return {
    latencies_ms: {
      p50: nsToMs(r.latencies['50th']),
      p90: nsToMs(r.latencies['90th']),
      p95: nsToMs(r.latencies['95th']),
      p99: nsToMs(r.latencies['99th']),
      max: nsToMs(r.latencies.max),
      mean: nsToMs(r.latencies.mean),
    },
    rate: r.rate,
    success: r.success,
  }
}

/** Tail/reliability stats from a completion report. Report bucket keys are the
 *  bucket lower-edge in nanoseconds (see CompletionReport). */
function tailFromReport(r: CompletionReport): TailStats {
  let errors = 0
  let timeouts = 0
  for (const [code, n] of Object.entries(r.status_codes ?? {})) {
    const num = Number(code)
    if (num === 504) timeouts += n
    if (num >= 400 || num === 0) errors += n
  }
  let overThreshold = 0
  for (const [ns, n] of Object.entries(r.buckets ?? {})) {
    if (nsToMs(Number(ns)) >= HIGH_LATENCY_MS) overThreshold += n
  }
  return { hasData: true, errors, timeouts, overThreshold, max: nsToMs(r.latencies.max) }
}

/**
 * Per-environment KPI snapshot for the tiles: the completion report when the
 * environment has finished, otherwise the latest live window. Recomputes on run
 * state, report arrival, and each live flush.
 */
export const kpiLatest: Readable<Partial<Record<RtbEnv, KpiSnapshot>>> = derived(
  [runState, finals, latest],
  ([$rs, $finals, $latest]) => {
    const out: Partial<Record<RtbEnv, KpiSnapshot>> = {}
    for (const env of ENVS) {
      const report = $finals[env]
      if (isComplete($rs, env) && report) out[env] = kpiFromReport(report)
      else if ($latest[env]) out[env] = $latest[env]
    }
    return out
  },
)

/**
 * Per-environment tail/reliability stats: the completion report when finished,
 * otherwise the accumulated live cache. `tick` is a dependency so the live path
 * recomputes on each flush.
 */
export const tailStats: Readable<Record<RtbEnv, TailStats>> = derived(
  [runState, finals, tick],
  ([$rs, $finals]) => {
    const out = {} as Record<RtbEnv, TailStats>
    for (const env of ENVS) {
      const report = $finals[env]
      out[env] = isComplete($rs, env) && report ? tailFromReport(report) : getTailStats(env)
    }
    return out
  },
)

/** The achieved request rate from the latest snapshots, falling back to the fixed target. */
export function currentRate(): number {
  const l = get(latest)
  const rates = ENVS.map((e) => l[e]?.rate).filter((r): r is number => typeof r === 'number')
  if (rates.length === 0) return get(fixedParams).rate
  return Math.max(...rates)
}
