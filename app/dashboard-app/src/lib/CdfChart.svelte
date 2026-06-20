<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import uPlot from 'uplot'
  import 'uplot/dist/uPlot.min.css'
  import { tick, getCdfData } from './store'
  import { ENV_TOKENS, HIGH_LATENCY_MS } from './contract'

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
        y: { range: [0, 100] }, // percent — fixed so both envs compare directly
      },
      axes: [
        {
          label: 'latency (ms)',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
        },
        {
          label: '% of requests under',
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke },
          values: (_u, splits) => splits.map((v) => `${v}%`),
        },
      ],
      series: [
        { label: 'latency' },
        {
          label: ENV_TOKENS.nlb.label,
          stroke: ENV_TOKENS.nlb.color,
          dash: ENV_TOKENS.nlb.dash,
          width: 2,
          spanGaps: true,
        },
        {
          label: ENV_TOKENS.rtbfabric.label,
          stroke: ENV_TOKENS.rtbfabric.color,
          width: 2,
          spanGaps: true,
        },
      ],
    }
  }

  function draw(): void {
    if (!chart) return
    const { x, series } = getCdfData()
    empty = x.length === 0
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

  $: if (chart) {
    void $tick
    draw()
  }
</script>

<section class="panel chart-panel">
  <div class="chart-head">
    <h2>Latency distribution (CDF)</h2>
    <span class="faint">higher/left is better · {HIGH_LATENCY_MS}ms tail tracked below</span>
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
