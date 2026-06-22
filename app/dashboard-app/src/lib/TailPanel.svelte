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
    <div class="tail-table">
      <div class="trow thead">
        <span class="tlabel"></span>
        <span class="tfill"></span>
        <div class="tvals">
          {#each ENVS as env (env)}
            <span class="tval">
              <span class="env-chip"><span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}</span>
            </span>
          {/each}
        </div>
      </div>

      <div class="tbody">
        {#each rows as r (r.key)}
          <div class="trow">
            <span class="tlabel">{r.label}</span>
            <span class="tfill"></span>
            <div class="tvals">
              {#each ENVS as env (env)}
                <span
                  class="tval"
                  class:warn={r.key !== 'max' && view[env].hasData && view[env][r.key] > 0}
                >
                  {cell(env, r.key)}
                </span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .tail-table {
    display: flex;
    flex-direction: column;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 8px;
    border-radius: 4px;
  }
  /* Zebra striping for easy row tracing; hover wins over the stripe. */
  .tbody .trow:nth-child(even) {
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .tbody .trow:hover {
    background: color-mix(in srgb, var(--text) 13%, transparent);
  }
  .thead {
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding-bottom: 8px;
    margin-bottom: 4px;
  }

  .tlabel {
    flex: 0 0 auto;
    color: var(--text-dim);
    font-size: 0.9rem;
    white-space: nowrap;
  }
  /* Flexible spacer pushes the value columns to the right, aligned across rows. */
  .tfill {
    flex: 1 1 auto;
    min-width: 18px;
  }

  .tvals {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: 120px 120px;
    gap: 0 28px;
    align-items: center;
  }
  .tval {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 1.05rem;
  }
  /* The header cells hold the env legend chip, not a number. */
  .thead .tval {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .tval.warn {
    color: var(--warn);
  }

  @media (max-width: 720px) {
    .tvals {
      grid-template-columns: 84px 84px;
      gap: 0 16px;
    }
  }
</style>
