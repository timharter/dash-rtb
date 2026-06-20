<script lang="ts">
  import { backendHealth } from './store'
  import { ENVS, ENV_TOKENS, formatInt, type RtbEnv, type BackendHealthMessage } from './contract'

  // Backend-health is optional supporting context sourced from metric-watcher
  // (bidder-side Prometheus). It is intentionally secondary to the client-
  // measured latency comparison and never required for the core view
  // (Requirements 12.1, 12.2, 12.3).

  $: envsWithData = ENVS.filter((e) => $backendHealth[e])

  // Friendly labels for known metric-watcher series; other keys are prettified.
  const LABELS: Record<string, string> = {
    bid_request_received_number: 'Requests received',
    bidder_request_number: 'Requests received',
    bid_request_active_number: 'Active requests',
    request_success_number: 'Successful',
    bidder_request_success_number: 'Successful',
    bad_request_number: 'Bad requests',
    request_timeout_number: 'Timeouts',
    bidder_request_timeout_number: 'Timeouts',
    server_error_number: 'Server errors',
    bidder_server_error_number: 'Server errors',
    no_bid_number: 'No-bids',
    bidder_no_bid_number: 'No-bids',
  }

  function prettify(key: string): string {
    return LABELS[key] ?? key.replace(/_number$/, '').replace(/_/g, ' ')
  }

  function pick(metrics: Record<string, number>, keys: string[]): number | undefined {
    for (const k of keys) if (typeof metrics[k] === 'number') return metrics[k]
    return undefined
  }

  function isUp(msg: BackendHealthMessage): boolean | null {
    const v = msg.metrics['up']
    return typeof v === 'number' ? v >= 1 : null
  }

  function noBidRate(metrics: Record<string, number>): string | null {
    const noBid = pick(metrics, ['bidder_no_bid_number', 'no_bid_number'])
    const received = pick(metrics, [
      'bidder_request_number',
      'bid_request_received_number',
      'request_success_number',
    ])
    if (noBid === undefined || !received) return null
    return `${((noBid / received) * 100).toFixed(1)}%`
  }

  function metricRows(msg: BackendHealthMessage): { label: string; value: string }[] {
    return Object.entries(msg.metrics)
      .filter(([k]) => k !== 'up')
      .map(([k, v]) => ({
        label: prettify(k),
        value: Number.isInteger(v) ? formatInt(v) : v.toFixed(2),
      }))
  }

  function envOf(e: RtbEnv): BackendHealthMessage {
    return $backendHealth[e] as BackendHealthMessage
  }
</script>

<section class="panel backend">
  <div class="bh-head">
    <h2>Backend health · bidder</h2>
    <span class="faint">Supporting context — same backend across both paths; the data path is the variable.</span>
  </div>

  {#if envsWithData.length === 0}
    <div class="idle-state">
      No bidder metrics yet. This optional panel populates when metric-watcher reports.
    </div>
  {:else}
    <div class="bh-grid">
      {#each envsWithData as env (env)}
        {@const msg = envOf(env)}
        <div class="bh-card">
          <div class="bh-card-head">
            <span class="env-chip"><span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}</span>
            {#if isUp(msg) !== null}
              <span class="up-badge {isUp(msg) ? 'up' : 'down'}">
                target {isUp(msg) ? 'up' : 'down'}
              </span>
            {/if}
          </div>
          {#if noBidRate(msg.metrics)}
            <div class="bh-row highlight">
              <span class="bh-label">No-bid rate</span><span class="bh-value">{noBidRate(msg.metrics)}</span>
            </div>
          {/if}
          {#each metricRows(msg) as row (row.label)}
            <div class="bh-row">
              <span class="bh-label">{row.label}</span><span class="bh-value">{row.value}</span>
            </div>
          {/each}
        </div>
      {/each}
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
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .bh-head .faint {
    font-size: 0.75rem;
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
  .bh-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.85rem;
    padding: 3px 0;
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
