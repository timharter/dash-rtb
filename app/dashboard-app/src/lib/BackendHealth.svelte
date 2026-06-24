<script lang="ts">
  import { backendHealth, healthBaseline } from './store'
  import { ENVS, formatInt, type BackendHealthMessage, type RtbEnv } from './contract'

  // Backend-health is optional supporting context sourced from metric-watcher
  // (bidder-side Prometheus). It is intentionally secondary to the client-
  // measured latency comparison and never required for the core view
  // (Requirements 12.1, 12.2, 12.3).
  //
  // metric-watcher emits one Prometheus series per bidder pod, embedding the
  // full label set in the metric key (with non-deterministic label ordering).
  // We aggregate by base metric name (sum across pods) so the panel shows a
  // small, stable set of totals that update in place — rather than a churning
  // list of per-series rows that never settle.

  // The bidder is a single shared backend across both paths, and metric-watcher
  // reports bidder-wide Prometheus totals (summed across bidder pods), not
  // per-path figures. During a simultaneous run the hub tags the same metrics
  // for both environments, which previously rendered two identical cards. Since
  // the metrics are not per-path, collapse to one shared card using the most
  // recent payload.
  $: bidderHealth = pickShared($backendHealth)

  function pickShared(
    bh: Partial<Record<RtbEnv, BackendHealthMessage>>,
  ): BackendHealthMessage | null {
    const msgs = ENVS.map((e) => bh[e]).filter((m): m is BackendHealthMessage => Boolean(m))
    if (msgs.length === 0) return null
    return msgs.reduce((a, b) => ((a.timestamp ?? '') >= (b.timestamp ?? '') ? a : b))
  }

  // Friendly labels for the known bidder metric-watcher series.
  const LABELS: Record<string, string> = {
    bidder_bid_request_received_number: 'Requests received',
    bidder_request_success_number: 'Successful',
    bidder_no_bid_number: 'No-bids',
    bidder_bid_request_active_number: 'Active requests',
    bidder_bad_request_number: 'Bad requests',
    bidder_request_timeout_number: 'Timeouts',
    bidder_server_error_number: 'Server errors',
  }

  // Fixed display order so rows keep stable positions across updates.
  const ORDER = [
    'bidder_bid_request_received_number',
    'bidder_request_success_number',
    'bidder_no_bid_number',
    'bidder_bid_request_active_number',
    'bidder_bad_request_number',
    'bidder_request_timeout_number',
    'bidder_server_error_number',
  ]

  /** Strips the `{label=value,...}` suffix from a Prometheus series key. */
  function baseName(key: string): string {
    const i = key.indexOf('{')
    return i < 0 ? key : key.slice(0, i)
  }

  interface Aggregate {
    sums: Record<string, number>
    upTotal: number
    upReady: number
  }

  // In-flight gauge (not a monotonic counter): show the live value, never a
  // delta. Everything else under bidder_* is a cumulative counter.
  const GAUGE_BASES = new Set(['bidder_bid_request_active_number'])

  /**
   * Sums bidder_* series by base metric name across pods. Aggregating by base
   * name is order-independent, so the non-deterministic label ordering in the
   * per-series keys (Go map iteration) does not matter.
   */
  function sumBidderByBase(metrics: Record<string, number>): Record<string, number> {
    const sums: Record<string, number> = {}
    for (const [key, val] of Object.entries(metrics)) {
      if (typeof val !== 'number') continue
      const base = baseName(key)
      if (base.startsWith('bidder_')) sums[base] = (sums[base] ?? 0) + val
    }
    return sums
  }

  /**
   * Aggregates the current sample and computes per-run deltas. Counters are
   * summed across pods by base name *before* subtracting the baseline — earlier
   * we subtracted per series key, but the keys' label ordering is random per
   * sample, so a mismatched key made the delta collapse to 0 (numbers ticking
   * up then reverting). Base-name subtraction is stable. Gauges pass through raw.
   */
  function aggregate(msg: BackendHealthMessage, baseline: Record<string, number> | null): Aggregate {
    const current = sumBidderByBase(msg.metrics)
    const base = baseline ? sumBidderByBase(baseline) : null

    const sums: Record<string, number> = {}
    for (const [b, v] of Object.entries(current)) {
      sums[b] = base && !GAUGE_BASES.has(b) ? Math.max(0, v - (base[b] ?? 0)) : v
    }

    // Bidder scrape-target up/down (a gauge) from the current sample only; ignore
    // the cluster-wide up series (kubelet, coredns, apiserver, node-exporter).
    let upTotal = 0
    let upReady = 0
    for (const [key, val] of Object.entries(msg.metrics)) {
      if (typeof val !== 'number') continue
      if (baseName(key) === 'up' && key.includes('bidder')) {
        upTotal++
        if (val >= 1) upReady++
      }
    }
    return { sums, upTotal, upReady }
  }

  function upStatus(agg: Aggregate): boolean | null {
    if (agg.upTotal === 0) return null
    return agg.upReady === agg.upTotal
  }

  function noBidRate(agg: Aggregate): string | null {
    const noBid = agg.sums['bidder_no_bid_number']
    const received = agg.sums['bidder_bid_request_received_number']
    if (noBid === undefined || !received) return null
    return `${((noBid / received) * 100).toFixed(1)}%`
  }

  function prettify(base: string): string {
    return base.replace(/^bidder_/, '').replace(/_number$/, '').replace(/_/g, ' ')
  }

  function rows(agg: Aggregate): { label: string; value: string }[] {
    const seen = new Set<string>()
    const out: { label: string; value: string }[] = []
    for (const base of ORDER) {
      if (agg.sums[base] === undefined) continue
      seen.add(base)
      out.push({ label: LABELS[base] ?? prettify(base), value: formatInt(agg.sums[base]) })
    }
    // Surface any other bidder_* metrics we didn't enumerate, for completeness.
    for (const [base, v] of Object.entries(agg.sums)) {
      if (seen.has(base)) continue
      out.push({ label: LABELS[base] ?? prettify(base), value: formatInt(v) })
    }
    return out
  }
</script>

<section class="panel backend">
  <div class="bh-head">
    <div class="bh-title">
      <h2>Backend health · bidder</h2>
      <span class="faint">Supporting context — same backend across both paths; the data path is the variable.</span>
    </div>
    <a
      class="grafana-btn"
      href="/grafana"
      target="_blank"
      rel="noopener noreferrer"
      title="Open Grafana in a new tab"
    >
      Grafana <span aria-hidden="true">↗</span>
    </a>
  </div>

  {#if !bidderHealth}
    <div class="idle-state">
      No bidder metrics yet. This optional panel populates when metric-watcher reports.
    </div>
  {:else}
    {@const agg = aggregate(bidderHealth, $healthBaseline)}
    <div class="bh-grid">
      <div class="bh-card">
        <div class="bh-card-head">
          <span class="bidder-chip">Bidder</span>
          <div class="bh-card-head-right">
            <span class="scope faint">{$healthBaseline ? 'since run start' : 'cumulative'}</span>
            {#if upStatus(agg) !== null}
              <span class="up-badge {upStatus(agg) ? 'up' : 'down'}">
                target {upStatus(agg) ? 'up' : 'down'}
              </span>
            {/if}
          </div>
        </div>
        <div class="bh-rows">
          {#if noBidRate(agg)}
            <div class="bh-row highlight">
              <span class="bh-label">No-bid rate</span>
              <span class="bh-value">{noBidRate(agg)}</span>
            </div>
          {/if}
          {#each rows(agg) as row (row.label)}
            <div class="bh-row">
              <span class="bh-label">{row.label}</span>
              <span class="bh-value">{row.value}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  /* Visually subordinate to the primary comparison: flatter background, smaller type. */
  .backend {
    background: var(--bg);
    border-style: dashed;
  }
  .bh-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .bh-title {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .bh-head .faint {
    font-size: 0.75rem;
  }
  /* External link to the Grafana dashboards (served at /grafana behind the same
     CloudFront distribution); opens in a new tab. */
  .grafana-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    font-size: 0.78rem;
    line-height: 1;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--text);
    text-decoration: none;
  }
  .grafana-btn:hover {
    border-color: color-mix(in srgb, var(--text) 40%, transparent);
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .bh-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--gap);
  }
  .bh-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg-panel);
  }
  .bh-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .bh-card-head-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scope {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .bidder-chip {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .up-badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .up-badge.up {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 50%, transparent);
  }
  .up-badge.down {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 55%, transparent);
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }
  .bh-rows {
    display: flex;
    flex-direction: column;
  }
  .bh-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.85rem;
    padding: 5px 8px;
    border-radius: 4px;
  }
  /* Zebra striping for easy row tracing; hover wins over the stripe. */
  .bh-rows .bh-row:nth-child(even) {
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .bh-rows .bh-row:hover {
    background: color-mix(in srgb, var(--text) 13%, transparent);
  }
  .bh-label {
    color: var(--text-dim);
    text-transform: capitalize;
  }
  .bh-value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .bh-row.highlight .bh-value {
    color: var(--text);
  }
</style>
