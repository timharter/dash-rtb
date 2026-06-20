<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import uPlot from 'uplot'
  import 'uplot/dist/uPlot.min.css'
  import { tick, getLatencySeries, hasAnyData } from './store'
  import { ENV_TOKENS, type LatencyPercentiles } from './contract'

  type Metric = Extract<keyof LatencyPercentiles, 'p50' | 'p95' | 'p99'>
  const metrics: { key: Metric; label: string }[] = [
    { key: 'p50', label: 'p50' },
    { key: 'p95', label: 'p95' },
    { key: 'p99', label: 'p99' },
  ]
  let metric: Metric = 'p99'

  let chartEl: HTMLDivElement
  let chart: uPlot | null = null
  let ro: ResizeObserver | null = null
  let empty = true

  const axisStroke = '#6b7c99'
  const gridStroke = 'rgba(38, 51, 80, 0.6)'

  function options(width: number): uPlot.Options {
    return {
      width,
      height: 280,
      legend: { show: true },
      cursor: { focus: { prox: 16 }, points: { size: 6 } },
      scales: {
        x: { time: false },
        // Pin the y baseline to 0 so the absolute NLB-vs-Fabric gap is never
        // flattened by auto-scaling (Requirement 2.3).
        y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.15 : 10] },
      },
      axes: [
        {
          label: 'elapsed (s)',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
        },
        {
          label: 'latency (ms)',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
        },
      ],
      series: [
        { label: 'elapsed' },
        {
          label: ENV_TOKENS.nlb.label,
          stroke: ENV_TOKENS.nlb.color,
          dash: ENV_TOKENS.nlb.dash,
          width: 2,
          spanGaps: false,
        },
        {
          label: ENV_TOKENS.rtbfabric.label,
          stroke: ENV_TOKENS.rtbfabric.color,
          width: 2,
          spanGaps: false,
        },
      ],
    }
  }

  function draw(): void {
    if (!chart) return
    const { x, series } = getLatencySeries(metric)
    empty = !hasAnyData()
    chart.setData([x, series.nlb, series.rtbfabric])
  }

  onMount(() => {
    chart = new uPlot(options(chartEl.clientWidth || 600), [[], [], []], chartEl)
    ro = new ResizeObserver(() => {
      if (chart) chart.setSize({ width: chartEl.clientWidth, height: 280 })
    })
    ro.observe(chartEl)
    draw()
  })

  onDestroy(() => {
    ro?.disconnect()
    chart?.destroy()
    chart = null
  })

  // Redraw on each batched tick or when the percentile toggle changes.
  $: if (chart) {
    void $tick
    void metric
    draw()
  }
</script>

<section class="panel chart-panel">
  <div class="chart-head">
    <h2>Live latency</h2>
    <div class="toggle" role="group" aria-label="Percentile">
      {#each metrics as m (m.key)}
        <button class="seg" class:active={metric === m.key} onclick={() => (metric = m.key)}>
          {m.label}
        </button>
      {/each}
    </div>
  </div>
  <div class="chart-wrap">
    <div class="chart" bind:this={chartEl}></div>
    {#if empty}
      <div class="overlay idle-state">No live data yet. Verify and run a comparison to begin.</div>
    {/if}
  </div>
</section>

<style>
  .chart-panel {
    min-width: 0;
  }
  .chart-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .chart-head h2 {
    margin: 0;
  }
  .toggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .seg {
    border: none;
    border-radius: 0;
    background: var(--bg-panel-2);
    padding: 5px 12px;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    border-right: 1px solid var(--border);
  }
  .seg:last-child {
    border-right: none;
  }
  .seg.active {
    background: color-mix(in srgb, var(--env-rtbfabric) 24%, var(--bg-panel-2));
    color: var(--text);
  }
  .chart-wrap {
    position: relative;
  }
  .chart {
    width: 100%;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
</style>
