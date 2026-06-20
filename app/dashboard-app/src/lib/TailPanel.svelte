<script lang="ts">
  import { tick, getTailStats, hasAnyData, type TailStats } from './store'
  import { ENVS, ENV_TOKENS, HIGH_LATENCY_MS, formatInt, formatMs } from './contract'

  interface TailView {
    nlb: TailStats
    rtbfabric: TailStats
    any: boolean
  }

  // Recompute on each batched tick by passing $tick as an argument (a real use,
  // so it registers as a reactive dependency).
  function computeTail(_tick: number): TailView {
    return { nlb: getTailStats('nlb'), rtbfabric: getTailStats('rtbfabric'), any: hasAnyData() }
  }
  $: view = computeTail($tick)

  const rows = [
    { key: 'errors' as const, label: 'Errors (non-2xx)' },
    { key: 'timeouts' as const, label: 'Timeouts (504)' },
    { key: 'overThreshold' as const, label: `Requests ≥ ${HIGH_LATENCY_MS} ms` },
    { key: 'max' as const, label: 'Max latency' },
  ]

  function cell(env: 'nlb' | 'rtbfabric', key: (typeof rows)[number]['key']): string {
    const s = view[env]
    if (!s.hasData) return '—'
    return key === 'max' ? formatMs(s.max) : formatInt(s[key])
  }
</script>

<section class="panel tail">
  <h2>Tail &amp; reliability</h2>
  {#if !view.any}
    <div class="idle-state">Tail and error metrics appear once a run is producing samples.</div>
  {:else}
    <div class="grid">
      <div class="hcell metric-head"></div>
      {#each ENVS as env (env)}
        <div class="hcell">
          <span class="env-chip"><span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}</span>
        </div>
      {/each}

      {#each rows as r (r.key)}
        <div class="metric-name">{r.label}</div>
        {#each ENVS as env (env)}
          <div class="value" class:warn={r.key !== 'max' && view[env].hasData && view[env][r.key] > 0}>
            {cell(env, r.key)}
          </div>
        {/each}
      {/each}
    </div>
  {/if}
</section>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr;
    gap: 8px 16px;
    align-items: center;
  }
  .hcell {
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .metric-name {
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  .value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 1.05rem;
  }
  .value.warn {
    color: var(--warn);
  }
</style>
