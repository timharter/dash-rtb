<script lang="ts">
  import {
    trials,
    autoTrials,
    readiness,
    isRunning,
    busy,
    startAutoTrials,
    stopAutoTrials,
    clearTrials,
    meanOf,
    stdDevOf,
    TRIAL_COUNT,
    TRIAL_DURATION_SEC,
    type TrialSummary,
  } from './store'
  import { ENVS, ENV_TOKENS } from './contract'

  type LatKey = 'p50' | 'p95' | 'p99'

  const latRows: { key: LatKey; label: string }[] = [
    { key: 'p50', label: 'p50 latency (ms)' },
    { key: 'p95', label: 'p95 latency (ms)' },
    { key: 'p99', label: 'p99 latency (ms)' },
  ]

  $: bothReady = $readiness?.nlb === 'ready' && $readiness?.rtbfabric === 'ready'
  $: active = $autoTrials?.active ?? false
  // Both environments advance together, so either length is the trial count.
  $: n = $trials.nlb.length
  $: hasResults = n > 0
  $: durLabel = `${Math.round(TRIAL_DURATION_SEC / 60)}m`

  function aggOf(xs: TrialSummary[], key: keyof TrialSummary): { mean: number; sd: number } {
    const vals = xs.map((t) => t[key])
    return { mean: meanOf(vals), sd: stdDevOf(vals) }
  }

  function latFmt(a: { mean: number; sd: number }): string {
    return `${a.mean.toFixed(2)} ± ${a.sd.toFixed(2)}`
  }

  function successFmt(xs: TrialSummary[]): string {
    const a = aggOf(xs, 'success')
    return `${(a.mean * 100).toFixed(3)}% ± ${(a.sd * 100).toFixed(3)}`
  }

  // RTB Fabric vs NLB mean delta for a latency metric (negative = Fabric lower).
  function deltaOf(
    nlbMean: number,
    rtbfMean: number,
  ): { text: string; dir: 'better' | 'worse' | 'neutral' } {
    if (!nlbMean) return { text: '—', dir: 'neutral' }
    const pct = ((nlbMean - rtbfMean) / nlbMean) * 100
    const dir = pct > 1 ? 'better' : pct < -1 ? 'worse' : 'neutral'
    return { text: `${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%`, dir }
  }

  // Reactive on $trials so the cells refresh as trials accumulate. (A plain
  // function reading $trials in the template would not re-run on store change.)
  $: view = {
    rows: latRows.map((r) => {
      const nlb = aggOf($trials.nlb, r.key)
      const rtbf = aggOf($trials.rtbfabric, r.key)
      const d = deltaOf(nlb.mean, rtbf.mean)
      return { label: r.label, nlb: latFmt(nlb), rtbfabric: latFmt(rtbf), delta: d.text, dir: d.dir }
    }),
    successNlb: successFmt($trials.nlb),
    successRtbfabric: successFmt($trials.rtbfabric),
  }
</script>

<section class="panel trials">
  <div class="row head">
    <div class="title">
      <h2>Repeated trials</h2>
      <span class="faint">Mean ± std dev across runs — the representative comparison.</span>
    </div>
    <div class="actions">
      {#if active}
        <span class="progress"
          >Trial {Math.min(($autoTrials?.completed ?? 0) + 1, $autoTrials?.total ?? 0)}/{$autoTrials?.total}
          running…</span
        >
        <button class="danger" onclick={() => stopAutoTrials()}>Stop trials</button>
      {:else}
        <button
          class="primary"
          disabled={!bothReady || $isRunning || $busy !== null}
          title={!bothReady ? 'Both environments must be ready — Verify configuration first' : ''}
          onclick={() => startAutoTrials()}
        >
          Run {TRIAL_COUNT} × {durLabel} trials
        </button>
        {#if hasResults}
          <button onclick={() => clearTrials()}>Clear</button>
        {/if}
      {/if}
    </div>
  </div>

  {#if hasResults}
    <div class="t-table">
      <div class="trow thead">
        <span class="tlabel">{n} trial{n === 1 ? '' : 's'}{active ? ' so far' : ''}</span>
        <div class="tvals">
          {#each ENVS as env (env)}
            <span class="tval"
              ><span class="env-chip"><span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}</span
              ></span
            >
          {/each}
          <span class="tval delta-head">Δ Fabric</span>
        </div>
      </div>

      {#each view.rows as row (row.label)}
        <div class="trow">
          <span class="tlabel">{row.label}</span>
          <div class="tvals">
            <span class="tval">{row.nlb}</span>
            <span class="tval">{row.rtbfabric}</span>
            <span class="tval delta {row.dir}">{row.delta}</span>
          </div>
        </div>
      {/each}

      <div class="trow">
        <span class="tlabel">Success rate</span>
        <div class="tvals">
          <span class="tval">{view.successNlb}</span>
          <span class="tval">{view.successRtbfabric}</span>
          <span class="tval delta neutral">—</span>
        </div>
      </div>
    </div>
  {:else if active}
    <div class="idle-state">
      Running trial 1 of {$autoTrials?.total}… results appear here as each {durLabel} trial completes.
    </div>
  {:else}
    <div class="idle-state">
      Runs {TRIAL_COUNT} simultaneous {durLabel} trials back-to-back and aggregates p50/p95/p99 so
      run-to-run variance is visible. Verify configuration first.
    </div>
  {/if}
</section>

<style>
  .trials {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title .faint {
    font-size: 0.78rem;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .progress {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .t-table {
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
  .t-table .trow:nth-child(odd):not(.thead) {
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .thead {
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding-bottom: 8px;
    margin-bottom: 4px;
  }
  .tlabel {
    flex: 1 1 auto;
    color: var(--text-dim);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .tvals {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: 130px 130px 80px;
    gap: 0 20px;
    align-items: center;
  }
  .tval {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 0.95rem;
  }
  .thead .tval {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .delta-head {
    color: var(--text-dim);
  }
  .delta.better {
    color: var(--good);
  }
  .delta.worse {
    color: var(--bad);
  }
  .delta.neutral {
    color: var(--text-dim);
  }

  @media (max-width: 720px) {
    .tvals {
      grid-template-columns: 92px 92px 60px;
      gap: 0 12px;
    }
  }
</style>
