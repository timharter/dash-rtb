<script lang="ts">
  // Latency-by-percentile ("tail latency") chart. A linear-axis CDF squashes a
  // low-latency-heavy distribution against 100% and hides the tail, so instead
  // we plot latency (y) against percentile (x) on a tail-emphasizing axis where
  // the nines (p50, p90, p99, p99.9) are evenly spaced. The tail — the NLB vs
  // RTB Fabric differentiator — is then front and center (Requirement 7.3).
  import { onMount, onDestroy } from 'svelte'
  import uPlot from 'uplot'
  import 'uplot/dist/uPlot.min.css'
  import { tick, getPercentileData, percentileForAxis, hasAnyData, PCTL_MAX_NINES } from './store'
  import { ENV_TOKENS, formatMs } from './contract'

  let chartEl: HTMLDivElement
  let chart: uPlot | null = null
  let ro: ResizeObserver | null = null
  let empty = true

  const axisStroke = '#6b7c99'
  const gridStroke = 'rgba(38, 51, 80, 0.6)'

  // Tick marks at p0(min), p50, p90, p99, p99.9 in transformed-axis space.
  const tickSplits = [0, 0.30103, 1, 2, 3]

  function tickLabel(xt: number): string {
    if (xt <= 0.0001) return 'min'
    const p = percentileForAxis(xt)
    const r = p >= 99.85 ? '99.9' : p >= 98.5 ? '99' : String(Math.round(p))
    return `p${r}`
  }

  function cursorPctLabel(xt: number): string {
    if (xt <= 0.0001) return 'min'
    const p = percentileForAxis(xt)
    const digits = p >= 99.9 ? 2 : p >= 99 ? 1 : 0
    return `p${p.toFixed(digits)}`
  }

  function options(width: number): uPlot.Options {
    return {
      width,
      height: 280,
      legend: { show: true },
      cursor: { focus: { prox: 16 }, points: { size: 6 } },
      scales: {
        x: { time: false, range: [0, PCTL_MAX_NINES] },
        y: { range: (_u, _min, max) => [0, max == null || max <= 0 ? 1 : max * 1.05] },
      },
      axes: [
        {
          label: 'percentile',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          splits: () => tickSplits,
          values: (_u, splits) => splits.map(tickLabel),
        },
        {
          label: 'latency (ms)',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
        },
      ],
      series: [
        { label: 'percentile', value: (_u, v) => (v == null ? '--' : cursorPctLabel(v)) },
        {
          label: ENV_TOKENS.nlb.label,
          stroke: ENV_TOKENS.nlb.color,
          dash: ENV_TOKENS.nlb.dash,
          width: 2,
          spanGaps: true,
          value: (_u, v) => (v == null ? '--' : formatMs(v)),
        },
        {
          label: ENV_TOKENS.rtbfabric.label,
          stroke: ENV_TOKENS.rtbfabric.color,
          width: 2,
          spanGaps: true,
          value: (_u, v) => (v == null ? '--' : formatMs(v)),
        },
      ],
    }
  }

  function draw(): void {
    if (!chart) return
    const { xt, series } = getPercentileData()
    empty = !hasAnyData()
    chart.setData([xt, series.nlb, series.rtbfabric])
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

  $: if (chart) {
    void $tick
    draw()
  }
</script>

<section class="panel chart-panel">
  <div class="chart-head">
    <h2>Latency by percentile</h2>
    <span class="faint">lower is better · the tail (p99+) is the differentiator</span>
  </div>
  <div class="chart-wrap">
    <div class="chart" bind:this={chartEl}></div>
    {#if empty}
      <div class="overlay idle-state">Distribution appears once a run produces samples.</div>
    {/if}
  </div>
</section>

<style>
  .chart-panel {
    min-width: 0;
  }
  .chart-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .chart-head h2 {
    margin: 0;
  }
  .chart-head .faint {
    font-size: 0.75rem;
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
