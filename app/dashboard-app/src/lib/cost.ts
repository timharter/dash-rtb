// Networking cost model for the dashboard's cost-savings visual.
//
// The same RTB traffic (measured by the load generator) is priced two different
// ways depending on the path:
//   - Traditional AWS networking is billed per-GB of data transfer. Rates here
//     mirror the workshop's Ad-Tech Data Transfer Calculator defaults (us-east-1).
//   - AWS RTB Fabric is billed per-transaction (per request + response, priced
//     per billion), NOT per-GB. The exact per-billion figure is volume/size
//     tiered, so it is an editable assumption rather than a hard-coded fact.
//
// We compute a path-agnostic traffic volume from the completion report(s) — the
// bytes and request counts are ~identical across environments since payloads
// match — and project it to a daily/monthly figure, the same extrapolation the
// workshop's cost module performs.
import type { CompletionReport } from './contract'

export type PathId = 'internet' | 'crossRegion' | 'crossAz' | 'sameAz' | 'rtbfabric'

export interface CostRates {
  internetPerGb: number
  crossRegionPerGb: number
  crossAzPerGb: number
  sameAzPerGb: number
  /** RTB Fabric per-transaction price, expressed per billion transactions
   *  (a transaction = one request or one response). Editable estimate. */
  rtbFabricPerBillionTxn: number
}

/** Defaults: traditional per-GB rates are the workshop calculator's us-east-1
 *  values; the RTB Fabric figure is an illustrative placeholder to be tuned to
 *  the authoritative AWS RTB Fabric pricing for the relevant volume/size tier. */
export const DEFAULT_RATES: CostRates = {
  internetPerGb: 0.05,
  crossRegionPerGb: 0.02,
  crossAzPerGb: 0.01,
  sameAzPerGb: 0,
  rtbFabricPerBillionTxn: 12,
}

export interface Projection {
  id: 'run' | 'day' | 'month'
  label: string
  seconds: number // 0 means "use the measured run length"
}

export const PROJECTIONS: Projection[] = [
  { id: 'run', label: 'This run', seconds: 0 },
  { id: 'day', label: 'Per day', seconds: 86_400 },
  { id: 'month', label: 'Per month', seconds: 2_592_000 }, // 30 days
]

/** Decimal GB (10^9 bytes), matching AWS data-transfer pricing tables. */
export const BYTES_PER_GB = 1e9

export interface RateVolume {
  bytesPerSec: number
  requestsPerSec: number
  runSeconds: number
  ok: boolean
}

/**
 * Path-agnostic traffic volume as per-second rates, averaged across whichever
 * completion reports are present (both environments carry matching payloads).
 */
export function volumeFromReports(reports: CompletionReport[]): RateVolume {
  const usable = reports.filter(
    (r) => r.bytes_in && r.bytes_out && (r.duration || (r.throughput && r.requests)),
  )
  if (usable.length === 0) return { bytesPerSec: 0, requestsPerSec: 0, runSeconds: 0, ok: false }

  let bps = 0
  let rps = 0
  let secs = 0
  for (const r of usable) {
    const runSec = r.duration ? r.duration / 1e9 : r.requests / r.throughput
    if (!(runSec > 0)) continue
    const bytes = (r.bytes_in?.total ?? 0) + (r.bytes_out?.total ?? 0)
    bps += bytes / runSec
    rps += r.requests / runSec
    secs = Math.max(secs, runSec)
  }
  return {
    bytesPerSec: bps / usable.length,
    requestsPerSec: rps / usable.length,
    runSeconds: secs,
    ok: bps > 0,
  }
}

export interface PathCost {
  id: PathId
  label: string
  cost: number
  note?: string
}

export interface CostResult {
  bytes: number
  requests: number
  transactions: number
  seconds: number
  paths: PathCost[]
}

/** Projects the per-second volume over `projectionSeconds` (or the run length
 *  when 0) and prices it across each path. */
export function computeCosts(
  v: RateVolume,
  projectionSeconds: number,
  rates: CostRates,
): CostResult {
  const seconds = projectionSeconds > 0 ? projectionSeconds : v.runSeconds
  const bytes = v.bytesPerSec * seconds
  const requests = v.requestsPerSec * seconds
  // RTB Fabric bills requests and responses; one response per request.
  const transactions = requests * 2
  const gb = bytes / BYTES_PER_GB

  const paths: PathCost[] = [
    { id: 'internet', label: 'Internet (DTO)', cost: gb * rates.internetPerGb },
    { id: 'crossRegion', label: 'Cross-region', cost: gb * rates.crossRegionPerGb },
    { id: 'crossAz', label: 'Cross-AZ (same region)', cost: gb * rates.crossAzPerGb },
    {
      id: 'sameAz',
      label: 'Same-AZ',
      cost: gb * rates.sameAzPerGb,
      note: 'free, but only within one account/AZ — not across partners',
    },
    {
      id: 'rtbfabric',
      label: 'RTB Fabric',
      cost: (transactions / 1e9) * rates.rtbFabricPerBillionTxn,
      note: 'per-transaction (requests + responses)',
    },
  ]
  return { bytes, requests, transactions, seconds, paths }
}

/** Percent saved by `b` relative to `a` (0..100); 0 when `a` is not positive. */
export function savingsPct(a: number, b: number): number {
  if (!(a > 0)) return 0
  return Math.max(0, ((a - b) / a) * 100)
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usdCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Currency formatting that stays readable across the range from cents (a
 *  single short run) to millions (monthly internet egress). */
export function formatUSD(n: number): string {
  if (n === 0) return '$0'
  if (n < 100) return usdCents.format(n)
  return usd.format(Math.round(n))
}

/** Compact GB/TB string for the volume basis line. */
export function formatGB(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(2)} TB`
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(gb * 1000).toFixed(0)} MB`
}

/** Compact count for transactions/requests (e.g. 1.2B, 3.4M, 12K). */
export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(Math.round(n))
}
