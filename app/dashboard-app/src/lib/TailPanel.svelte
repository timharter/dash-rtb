<script lang="ts">
  import { tailStats, finals, runState, type TailStats } from './store'
  import { ENVS, ENV_TOKENS, HIGH_LATENCY_MS, formatInt, formatMs, type RtbEnv } from './contract'

  type TailKey = 'errors' | 'timeouts' | 'overThreshold' | 'max'

  const ROWS: { key: TailKey; label: string }[] = [
    { key: 'errors', label: 'Errors (non-2xx)' },
    { key: 'timeouts', label: 'Timeouts (504)' },
    { key: 'overThreshold', label: `Requests ≥ ${HIGH_LATENCY_MS} ms` },
    { key: 'max', label: 'Max latency' },
  ]

  function cellText(s: TailStats, key: TailKey): string {
    if (!s.hasData) return '—'
    return key === 'max' ? formatMs(s.max) : formatInt(s[key])
  }

  // Per-environment tail stats: the authoritative completion report once an
  // environment finishes, otherwise the live accumulation (see store.tailStats).
  $: view = $tailStats
  $: anyData = view.nlb.hasData || view.rtbfabric.hasData
  $: hasReports = Boolean($finals.nlb || $finals.rtbfabric)

  // Precompute the table reactively from $tailStats. The cells MUST be derived
  // here rather than via a function called in the markup: a function reading
  // $tailStats inside the template is not re-run when the store changes, which
  // froze the cells at whatever subset of envs had data on first render (the
  // "only one column updates" bug).
  $: tableRows = ROWS.map((r) => ({
    label: r.label,
    cells: ENVS.map((env) => ({
      env,
      text: cellText(view[env], r.key),
      warn: r.key !== 'max' && view[env].hasData && (view[env][r.key] as number) > 0,
    })),
  }))

  // Offline analysis: a raw completion report exists per environment once that
  // environment finishes. Download serializes the exact payload the
  // load-generator emitted (latencies, buckets, status codes, bytes, errors).
  function downloadReport(env: RtbEnv): void {
    const report = $finals[env]
    if (!report) return
    const runId = $runState?.run_id ?? 'run'
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rtb-report-${env}-${runId}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
</script>

<section class="panel tail">
  <div class="row head">
    <h2>Tail &amp; reliability</h2>
    {#if hasReports}
      <div class="report-downloads">
        <span class="faint">Raw report:</span>
        {#each ENVS as env (env)}
          {#if $finals[env]}
            <button
              class="dl"
              onclick={() => downloadReport(env)}
              title={`Download the raw ${ENV_TOKENS[env].label} completion report (JSON) for offline analysis`}
            >
              <span class="env-swatch {env}"></span>{ENV_TOKENS[env].label} ↓
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  {#if !anyData}
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
        {#each tableRows as r (r.label)}
          <div class="trow">
            <span class="tlabel">{r.label}</span>
            <span class="tfill"></span>
            <div class="tvals">
              {#each r.cells as c (c.env)}
                <span class="tval" class:warn={c.warn}>{c.text}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .report-downloads {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.8rem;
  }
  .dl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel-2);
    color: var(--text);
    cursor: pointer;
  }
  .dl:hover {
    border-color: color-mix(in srgb, var(--text) 35%, transparent);
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
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
