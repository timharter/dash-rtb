// Shared message contract mirrored from the dashboard service
// (guidance-rtb/tools/rtb-dashboard/internal/contract/contract.go) and the
// load-generator. Keep field names in sync with the Go struct json tags.

export type RtbEnv = 'nlb' | 'rtbfabric'

/** Fixed environment order used everywhere for deterministic rendering. */
export const ENVS: RtbEnv[] = ['nlb', 'rtbfabric']

export type ReadinessStatus = 'ready' | 'not-ready'

export interface ReadinessEvent {
  nlb: ReadinessStatus
  rtbfabric: ReadinessStatus
  reasons?: Record<string, string>
}

export type RunStatus = 'idle' | 'running' | 'complete' | 'failed' | 'stopped'

export interface RunEnvState {
  status: RunStatus
  error?: string
}

export interface RunState {
  run_id: string
  mode: string
  environments: Record<string, RunEnvState>
}

export interface LatencyPercentiles {
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
  mean: number
}

export interface IntervalSnapshot {
  type: 'live-metrics'
  source: 'load-generator'
  'rtb-env': RtbEnv
  elapsed_seconds: number
  window_seconds: number
  latencies_ms: LatencyPercentiles
  rate: number
  success: number
  status_codes: Record<string, number>
  buckets: Record<string, number>
}

/** metric-watcher message routed to the backend-health SSE event. */
export interface BackendHealthMessage {
  timestamp?: string
  type: string
  source: 'metric-watcher'
  'rtb-env': RtbEnv
  metrics: Record<string, number>
}

export type RunMode = RtbEnv | 'both'

// SSE event names emitted by the dashboard service.
export const SSE_LIVE_METRICS = 'live-metrics'
export const SSE_REPORT = 'report'
export const SSE_READINESS = 'readiness'
export const SSE_RUN_STATE = 'run-state'
export const SSE_BACKEND_HEALTH = 'backend-health'

// ---------------------------------------------------------------------------
// Per-environment visual tokens. Each environment gets a distinct color AND a
// non-color cue (line style) so panels stay legible for color-blind viewers and
// on projectors (Requirement 7.6).
// ---------------------------------------------------------------------------

export interface EnvToken {
  key: RtbEnv
  label: string
  color: string
  /** uPlot dash pattern; empty array = solid line. */
  dash: number[]
  /** CSS border style cue used in legends/tiles. */
  borderStyle: 'solid' | 'dashed'
}

export const ENV_TOKENS: Record<RtbEnv, EnvToken> = {
  nlb: {
    key: 'nlb',
    label: 'NLB',
    color: '#f59e0b', // amber
    dash: [6, 4],
    borderStyle: 'dashed',
  },
  rtbfabric: {
    key: 'rtbfabric',
    label: 'RTB Fabric',
    color: '#22d3ee', // cyan
    dash: [],
    borderStyle: 'solid',
  },
}

/**
 * Server-side fixed load parameters. The dashboard cannot change these (only
 * duration is user-selectable); they are shown read-only so viewers understand
 * throughput is held constant and latency is the variable (Requirement 4.10,
 * 7.5). Rate mirrors the ~1,000 TPS RTB Fabric ceiling.
 */
export const FIXED_PARAMS = {
  rate: 1000,
  devices: 100,
  workers: 50,
}

// Duration bounds for the run control (seconds). Default 5 minutes
// (Requirement 4.10).
export const DURATION = {
  min: 60,
  max: 900,
  default: 300,
  step: 30,
}

/** High-latency threshold (ms) for the tail/reliability panel (Requirement 7.4). */
export const HIGH_LATENCY_MS = 50

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------

export function formatMs(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 100) return `${Math.round(v)} ms`
  return `${v.toFixed(1)} ms`
}

/** Formats a 0..1 success ratio as an error percentage string. */
export function formatErrorPct(success: number | null | undefined): string {
  if (success === null || success === undefined || Number.isNaN(success)) return '—'
  const errPct = Math.max(0, (1 - success) * 100)
  return `${errPct.toFixed(2)}%`
}

export function formatRate(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

export function formatInt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  if (s === 0) return `${m}m`
  return `${m}m ${s}s`
}

/** Go time.Duration string for the run-control request, e.g. 300 -> "300s". */
export function durationToGo(seconds: number): string {
  return `${seconds}s`
}

export type DeltaDirection = 'better' | 'worse' | 'neutral'

export interface Delta {
  text: string
  direction: DeltaDirection
}

/**
 * Computes the RTB-Fabric-vs-NLB delta for a "lower is better" metric (latency,
 * error rate). Positive percentage = RTB Fabric is lower (better).
 */
export function lowerIsBetterDelta(
  nlb: number | null | undefined,
  rtbfabric: number | null | undefined,
): Delta {
  if (
    nlb === null || nlb === undefined || Number.isNaN(nlb) ||
    rtbfabric === null || rtbfabric === undefined || Number.isNaN(rtbfabric) ||
    nlb === 0
  ) {
    return { text: '—', direction: 'neutral' }
  }
  const pct = ((nlb - rtbfabric) / nlb) * 100
  const direction: DeltaDirection = pct > 1 ? 'better' : pct < -1 ? 'worse' : 'neutral'
  const sign = pct > 0 ? '−' : '+' // RTB Fabric lower => shows a reduction
  return { text: `${sign}${Math.abs(pct).toFixed(0)}% vs NLB`, direction }
}

// ---------------------------------------------------------------------------
// Bucket / CDF shaping (pure functions, unit-testable).
// ---------------------------------------------------------------------------

export interface BucketBounds {
  lo: number
  hi: number // Infinity for the open-ended overflow bucket
}

/**
 * Parses a histogram bucket label produced by the load-generator. Labels are
 * "loMs-hiMs" (e.g. "3-4.5") or "loMs-+Inf" for the open-ended top bucket.
 */
export function parseBucketBounds(key: string): BucketBounds {
  const dash = key.indexOf('-')
  if (dash < 0) {
    const lo = Number(key)
    return { lo: Number.isFinite(lo) ? lo : 0, hi: Infinity }
  }
  const loStr = key.slice(0, dash)
  const hiStr = key.slice(dash + 1)
  const lo = Number(loStr)
  const hi = hiStr.includes('Inf') ? Infinity : Number(hiStr)
  return {
    lo: Number.isFinite(lo) ? lo : 0,
    hi: Number.isFinite(hi) ? hi : Infinity,
  }
}

/** Adds the counts of `src` into `dst` in place (per-bucket sum). */
export function addBuckets(dst: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) {
    dst[k] = (dst[k] ?? 0) + v
  }
}

export interface CdfCurve {
  x: number[] // latency threshold (ms)
  y: number[] // cumulative percent of requests under x
}

/**
 * Builds a CDF ("percent of requests under X ms") from aggregated histogram
 * buckets. Finite buckets contribute a point at their upper edge; the
 * open-ended overflow bucket contributes only to the denominator, so the curve
 * honestly approaches (but may not reach) 100% when there is a long tail
 * (Requirement 7.3).
 */
export function buildCdf(buckets: Record<string, number>): CdfCurve {
  const parsed = Object.entries(buckets)
    .map(([k, count]) => ({ ...parseBucketBounds(k), count }))
    .filter((b) => b.count > 0)
    .sort((a, b) => a.lo - b.lo)

  const total = parsed.reduce((s, b) => s + b.count, 0)
  if (total === 0) return { x: [], y: [] }

  const x: number[] = []
  const y: number[] = []
  // Anchor the curve at the smallest lower edge, 0%.
  x.push(parsed[0].lo)
  y.push(0)

  let cum = 0
  for (const b of parsed) {
    cum += b.count
    if (!Number.isFinite(b.hi)) continue // overflow: denominator only
    const xi = b.hi
    const yi = (cum / total) * 100
    if (xi <= x[x.length - 1]) {
      y[y.length - 1] = Math.max(y[y.length - 1], yi)
    } else {
      x.push(xi)
      y.push(yi)
    }
  }
  return { x, y }
}

/**
 * Samples a monotonic step CDF onto a shared x grid so two environments with
 * different bucket edges can overlay on one axis. For each grid value the
 * sampled y is the cumulative percent at the largest curve point <= x, else 0.
 */
export function sampleCdf(curve: CdfCurve, grid: number[]): (number | null)[] {
  if (curve.x.length === 0) return grid.map(() => null)
  const out: (number | null)[] = []
  let i = 0
  for (const gx of grid) {
    while (i + 1 < curve.x.length && curve.x[i + 1] <= gx) i++
    if (gx < curve.x[0]) {
      out.push(0)
    } else {
      out.push(curve.y[i])
    }
  }
  return out
}

/** Sorted union of two numeric arrays (deduplicated). */
export function unionSorted(a: number[], b: number[]): number[] {
  const set = new Set<number>()
  for (const v of a) set.add(v)
  for (const v of b) set.add(v)
  return Array.from(set).sort((x, y) => x - y)
}
