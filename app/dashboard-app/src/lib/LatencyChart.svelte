<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import uPlot from 'uplot'
  import 'uplot/dist/uPlot.min.css'
  import { tick, getLatencySeries, hasAnyData } from './store'
  import { ENV_TOKENS, type LatencyPercentiles } from './contract'
  import ChartModal from './ChartModal.svelte'

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

  // Expanded ("blown up") view: a second uPlot instance lives inside the modal
  // and is fed from the same store getters as the inline one (see draw()).
  let expanded = false
  let modalChart: uPlot | null = null

  const axisStroke = '#6b7c99'
  const gridStroke = 'rgba(38, 51, 80, 0.6)'

  function options(width: number, height = 280): uPlot.Options {
    return {
      width,
      height,
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
    const { x, series } = getLatencySeries(metric)
    empty = !hasAnyData()
    const data: uPlot.AlignedData = [x, series.nlb, series.rtbfabric]
    chart?.setData(data)
    modalChart?.setData(data)
  }

  // Svelte action: create the expanded chart when the modal element mounts and
  // tear it down when it unmounts (i.e. when `expanded` flips false). Height
  // tracks the viewport so the blown-up chart fills the overlay; width/height
  // follow window resizes.
  function modalChartView(node: HTMLDivElement) {
    const heightFor = () => Math.max(200, Math.round(window.innerHeight * 0.72))
    modalChart = new uPlot(options(node.clientWidth, heightFor()), [[], [], []], node)
    draw()
    const onResize = () => modalChart?.setSize({ width: node.clientWidth, height: heightFor() })
    window.addEventListener('resize', onResize)
    return {
      destroy() {
        window.removeEventListener('resize', onResize)
        modalChart?.destroy()
        modalChart = null
      },
    }
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
    <div class="head-right">
      <div class="toggle" role="group" aria-label="Percentile">
        {#each metrics as m (m.key)}
          <button class="seg" class:active={metric === m.key} onclick={() => (metric = m.key)}>
            {m.label}
          </button>
        {/each}
      </div>
      <button class="expand" onclick={() => (expanded = true)} aria-label="Expand chart" title="Expand chart">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </button>
    </div>
  </div>
  <div class="chart-wrap">
    <div class="chart" bind:this={chartEl}></div>
    {#if empty}
      <div class="overlay idle-state">No live data yet. Verify and run a comparison to begin.</div>
    {/if}
  </div>
</section>

{#if expanded}
  <ChartModal title="Live latency" onClose={() => (expanded = false)}>
    <div class="toggle" role="group" aria-label="Percentile" slot="controls">
      {#each metrics as m (m.key)}
        <button class="seg" class:active={metric === m.key} onclick={() => (metric = m.key)}>
          {m.label}
        </button>
      {/each}
    </div>
    <div class="modal-chart" use:modalChartView></div>
  </ChartModal>
{/if}

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
  .head-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .expand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    color: var(--text-dim);
  }
  .expand:hover {
    color: var(--text);
  }
  .modal-chart {
    width: 100%;
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
