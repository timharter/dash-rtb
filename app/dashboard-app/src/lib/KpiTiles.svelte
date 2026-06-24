<script lang="ts">
  import { kpiLatest } from './store'
  import {
    ENV_TOKENS,
    formatMs,
    formatRate,
    formatErrorPct,
    lowerIsBetterDelta,
    type Delta,
    type KpiSnapshot,
  } from './contract'

  interface Tile {
    label: string
    nlb: string
    rtbfabric: string
    delta: Delta
  }

  function errorFraction(s: KpiSnapshot | undefined): number | undefined {
    return s ? 1 - s.success : undefined
  }

  // KPI tiles show the current value per environment with the RTB-Fabric-vs-NLB
  // delta (Requirement 7.1). While running this is the latest live window; once
  // an environment completes it is the authoritative completion report, so the
  // tiles no longer latch onto the noisy final partial window. Latency and error
  // use "lower is better"; throughput is held fixed so its delta stays neutral.
  $: nlb = $kpiLatest.nlb
  $: rtb = $kpiLatest.rtbfabric
  $: tiles = [
    {
      label: 'p99 latency',
      nlb: formatMs(nlb?.latencies_ms.p99),
      rtbfabric: formatMs(rtb?.latencies_ms.p99),
      delta: lowerIsBetterDelta(nlb?.latencies_ms.p99, rtb?.latencies_ms.p99),
    },
    {
      label: 'p50 latency',
      nlb: formatMs(nlb?.latencies_ms.p50),
      rtbfabric: formatMs(rtb?.latencies_ms.p50),
      delta: lowerIsBetterDelta(nlb?.latencies_ms.p50, rtb?.latencies_ms.p50),
    },
    {
      label: 'Mean latency',
      nlb: formatMs(nlb?.latencies_ms.mean),
      rtbfabric: formatMs(rtb?.latencies_ms.mean),
      delta: lowerIsBetterDelta(nlb?.latencies_ms.mean, rtb?.latencies_ms.mean),
    },
    {
      label: 'Throughput',
      nlb: nlb ? `${formatRate(nlb.rate)}/s` : '—',
      rtbfabric: rtb ? `${formatRate(rtb.rate)}/s` : '—',
      delta: { text: '', direction: 'neutral' } as Delta,
    },
    {
      label: 'Error rate',
      nlb: formatErrorPct(nlb?.success),
      rtbfabric: formatErrorPct(rtb?.success),
      delta: lowerIsBetterDelta(errorFraction(nlb), errorFraction(rtb)),
    },
  ] satisfies Tile[]
</script>

<section class="kpis">
  {#each tiles as t (t.label)}
    <div class="panel tile">
      <h2>{t.label}</h2>
      <div class="values">
        <div class="val-row">
          <span class="env-chip"><span class="env-swatch nlb"></span>{ENV_TOKENS.nlb.label}</span>
          <span class="val">{t.nlb}</span>
        </div>
        <div class="val-row">
          <span class="env-chip"
            ><span class="env-swatch rtbfabric"></span>{ENV_TOKENS.rtbfabric.label}</span
          >
          <span class="val">{t.rtbfabric}</span>
        </div>
      </div>
      {#if t.delta.text}
        <div class="delta {t.delta.direction}">{t.delta.text}</div>
      {:else}
        <div class="delta neutral">&nbsp;</div>
      {/if}
    </div>
  {/each}
</section>

<style>
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--gap);
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .values {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .val-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .val {
    font-size: 1.35rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .delta {
    font-size: 0.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
