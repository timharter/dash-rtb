<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import {
    connectStream,
    disconnectStream,
    connection,
    isRunning,
    terminalOpen,
    fixedParams,
  } from './lib/store'
  import { ENVS, ENV_TOKENS, formatRate } from './lib/contract'
  import Controls from './lib/Controls.svelte'
  import TrialsPanel from './lib/TrialsPanel.svelte'
  import KpiTiles from './lib/KpiTiles.svelte'
  import LatencyChart from './lib/LatencyChart.svelte'
  import CdfChart from './lib/CdfChart.svelte'
  import TailPanel from './lib/TailPanel.svelte'
  import BackendHealth from './lib/BackendHealth.svelte'
  import Terminal from './lib/Terminal.svelte'

  onMount(() => connectStream())
  onDestroy(() => disconnectStream())

  const connectionLabel: Record<string, string> = {
    open: 'Live',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
  }
</script>

<div class="app">
  <header class="topbar">
    <div class="title">
      <h1>RTB Fabric vs NLB</h1>
      <span class="subtitle">Live latency comparison</span>
    </div>

    <div class="rate-banner" title="Request rate is held constant; latency is the variable being compared.">
      <span class="rate-value">{formatRate($fixedParams.rate)}</span>
      <span class="rate-unit">req/s · fixed</span>
    </div>

    <div class="topbar-right">
      <button
        class="term-launch"
        class:active={$terminalOpen}
        onclick={() => terminalOpen.update((v) => !v)}
        aria-pressed={$terminalOpen}
        title="Open the workshop terminal"
      >
        <span class="term-launch-glyph" aria-hidden="true">›_</span>
        Terminal
      </button>

      <div class="legend">
        {#each ENVS as env (env)}
          <span class="env-chip">
            <span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}
          </span>
        {/each}
      </div>
      <span class="conn conn-{$connection}" class:running={$isRunning}>
        <span class="dot"></span>{connectionLabel[$connection]}
      </span>
    </div>
  </header>

  <Controls />

  <TrialsPanel />

  <KpiTiles />

  <section class="charts">
    <LatencyChart />
    <CdfChart />
  </section>

  <TailPanel />

  <BackendHealth />

  <Terminal />

  <footer class="footnote">
    Latency is measured client-side by the load generator — the only vantage point that observes
    the NLB-vs-Fabric data-path difference.
  </footer>
</div>

<style>
  .app {
    max-width: 1400px;
    margin: 0 auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    padding: 8px 4px;
  }

  .title h1 {
    font-size: 1.35rem;
  }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  .rate-banner {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-panel);
  }
  .rate-value {
    font-size: 1.5rem;
    font-weight: 750;
    line-height: 1;
    color: var(--text);
  }
  .rate-unit {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }

  .topbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .legend {
    display: flex;
    gap: 14px;
  }

  .term-launch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 7px 14px;
  }
  .term-launch-glyph {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: var(--env-rtbfabric);
  }
  .term-launch.active {
    border-color: var(--env-rtbfabric);
    background: color-mix(in srgb, var(--env-rtbfabric) 18%, var(--bg-panel-2));
  }

  .conn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .conn .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .conn-open .dot {
    background: var(--good);
  }
  .conn-reconnecting .dot {
    background: var(--warn);
  }
  .conn.running .dot {
    box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5);
    }
    70% {
      box-shadow: 0 0 0 7px rgba(52, 211, 153, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(52, 211, 153, 0);
    }
  }

  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--gap);
  }

  .footnote {
    color: var(--text-faint);
    font-size: 0.78rem;
    text-align: center;
    padding: 8px 0 24px;
  }

  @media (max-width: 900px) {
    .charts {
      grid-template-columns: 1fr;
    }
    .topbar-right {
      margin-left: 0;
    }
  }
</style>
