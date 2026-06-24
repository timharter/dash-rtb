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
  import { isXZoomed, resetXZoom } from './chartZoom'
  import ChartModal from './ChartModal.svelte'

  let chartEl: HTMLDivElement
  let chart: uPlot | null = null
  let ro: ResizeObserver | null = null
  let empty = true

  // Expanded ("blown up") view: a second uPlot instance lives inside the modal
  // and is fed from the same store getters as the inline one (see draw()).
  let expanded = false
  let modalChart: uPlot | null = null

  // Whether each chart is currently drag-zoomed, so we can offer a reset.
  let inlineZoomed = false
  let modalZoomed = false

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

  function options(width: number, height = 280, setZoom: (z: boolean) => void = () => {}): uPlot.Options {
    return {
      width,
      height,
      legend: { show: true },
      cursor: { focus: { prox: 16 }, points: { size: 6 } },
      scales: {
        // A function (not a static [0, max] array) keeps the x-scale zoomable:
        // an array sets scale.auto=false and disables drag-zoom. On auto-scale
        // and reset uPlot requests the full data extent, which we pin to the
        // exact percentile domain; a drag-zoom requests a narrower sub-range,
        // which we pass through so zoom works like the live-latency chart.
        x: {
          time: false,
          range: (_u, initMin, initMax) => {
            if (!Number.isFinite(initMin) || !Number.isFinite(initMax)) return [0, PCTL_MAX_NINES]
            const full = initMin <= 1e-6 && initMax >= PCTL_MAX_NINES - 1e-6
            return full ? [0, PCTL_MAX_NINES] : [initMin, initMax]
          },
        },
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
      hooks: {
        setScale: [
          (u, key) => {
            if (key === 'x') setZoom(isXZoomed(u))
          },
        ],
      },
    }
  }

  function draw(): void {
    const { xt, series } = getPercentileData()
    empty = !hasAnyData()
    const data: uPlot.AlignedData = [xt, series.nlb, series.rtbfabric]
    chart?.setData(data)
    modalChart?.setData(data)
  }

  // Svelte action: create the expanded chart when the modal element mounts and
  // tear it down when it unmounts (i.e. when `expanded` flips false). Height
  // tracks the viewport so the blown-up chart fills the overlay; width/height
  // follow window resizes.
  function modalChartView(node: HTMLDivElement) {
    const heightFor = () => Math.max(200, Math.round(window.innerHeight * 0.72))
    modalChart = new uPlot(options(node.clientWidth, heightFor(), (z) => (modalZoomed = z)), [[], [], []], node)
    draw()
    const onResize = () => modalChart?.setSize({ width: node.clientWidth, height: heightFor() })
    window.addEventListener('resize', onResize)
    return {
      destroy() {
        window.removeEventListener('resize', onResize)
        modalChart?.destroy()
        modalChart = null
        modalZoomed = false
      },
    }
  }

  onMount(() => {
    chart = new uPlot(options(chartEl.clientWidth || 600, 280, (z) => (inlineZoomed = z)), [[], [], []], chartEl)
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
    <div class="head-right">
      <span class="faint">lower is better · the tail (p99+) is the differentiator</span>
      {#if inlineZoomed}
        <button class="reset" onclick={() => resetXZoom(chart)} title="Reset zoom to full range">Reset zoom</button>
      {/if}
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
      <div class="overlay idle-state">Distribution appears once a run produces samples.</div>
    {/if}
  </div>
</section>

{#if expanded}
  <ChartModal title="Latency by percentile" onClose={() => (expanded = false)}>
    <div class="modal-controls" slot="controls">
      <span class="faint">lower is better · the tail (p99+) is the differentiator</span>
      {#if modalZoomed}
        <button class="reset" onclick={() => resetXZoom(modalChart)} title="Reset zoom to full range">Reset zoom</button>
      {/if}
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
    gap: 12px;
    margin-bottom: 8px;
  }
  .chart-head h2 {
    margin: 0;
  }
  .chart-head .faint {
    font-size: 0.75rem;
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
    flex: 0 0 auto;
  }
  .expand:hover {
    color: var(--text);
  }
  .reset {
    padding: 4px 10px;
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .modal-controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .modal-chart {
    width: 100%;
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
