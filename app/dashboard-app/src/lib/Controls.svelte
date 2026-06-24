<script lang="ts">
  import {
    readiness,
    runState,
    isRunning,
    busy,
    actionError,
    fixedParams,
    autoTrials,
    verify,
    runTest,
    stopTest,
  } from './store'
  import {
    ENVS,
    ENV_TOKENS,
    DURATION,
    formatDuration,
    formatRate,
    type RtbEnv,
    type RunMode,
    type RunStatus,
  } from './contract'

  let duration = DURATION.default
  let mode: RunMode = 'both'

  const modes: { value: RunMode; label: string }[] = [
    { value: 'nlb', label: 'NLB only' },
    { value: 'rtbfabric', label: 'RTB Fabric only' },
    { value: 'both', label: 'Both (simultaneous)' },
  ]

  // Readiness gating (Requirement 5). Controls stay disabled until an explicit
  // verification reports an environment ready; readiness is restored across
  // reloads via the SSE snapshot, so this persists without re-querying.
  $: verified = $readiness !== null
  $: ready = (env: RtbEnv): boolean => $readiness?.[env] === 'ready'
  $: avail = {
    nlb: ready('nlb'),
    rtbfabric: ready('rtbfabric'),
    both: ready('nlb') && ready('rtbfabric'),
  }
  $: anyReady = avail.nlb || avail.rtbfabric

  // Keep the selected mode on an available option so Run is never stuck
  // disabled when at least one environment is ready (Requirement 5.5).
  $: if (anyReady && !avail[mode]) {
    mode = avail.both ? 'both' : avail.nlb ? 'nlb' : 'rtbfabric'
  }

  // Auto-trials (the Repeated trials panel) drive their own runs; lock the
  // manual controls while a sequence is active to avoid conflicting launches.
  $: autoActive = $autoTrials?.active ?? false
  $: runDisabled = $busy !== null || $isRunning || !anyReady || !avail[mode] || autoActive
  $: stopDisabled = $busy !== null || !$isRunning || autoActive

  function runHint(): string {
    if (autoActive) return 'Auto-trials are running — use the Repeated trials panel to stop.'
    if (!verified) return 'Click “Verify configuration” first to check readiness.'
    if ($isRunning) return 'A run is already in progress. Stop it before launching another.'
    if (!anyReady) return 'No environment is ready yet — see the status above.'
    if (!avail[mode]) {
      if (mode === 'both') return 'Both environments must be ready for a simultaneous run.'
      return `${ENV_TOKENS[mode as RtbEnv].label} is not ready yet.`
    }
    return ''
  }

  // These are reactive ($:) so the template re-evaluates them when $readiness
  // changes after a verify. As plain functions they were computed once at mount
  // (readiness still null) and never refreshed by Svelte's dirty tracking —
  // which left the reason text stale and the detected endpoint hidden, even
  // though the status pill (a reactive $: value) updated correctly.
  $: reasonFor = (env: RtbEnv): string => {
    const r = $readiness?.reasons?.[env]
    if (r) return r
    return ready(env) ? 'Ready to run' : 'Not ready'
  }

  // The detected bid-request endpoint for an environment, surfaced after verify
  // so the user can confirm the right RTB Fabric link / NLB was discovered
  // before launching a load test.
  $: endpointFor = (env: RtbEnv): string => $readiness?.endpoints?.[env] ?? ''

  // Copy the detected endpoint to the clipboard with brief inline feedback. The
  // dashboard is served over HTTPS so the async Clipboard API is available; the
  // textarea path is a defensive fallback for non-secure contexts.
  let copiedEnv: RtbEnv | null = null
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  async function copyEndpoint(env: RtbEnv): Promise<void> {
    const url = endpointFor(env)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* clipboard unavailable; ignore */
      }
      ta.remove()
    }
    copiedEnv = env
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copiedEnv = null), 1500)
  }

  const modeLabels: Record<string, string> = {
    nlb: 'NLB only',
    rtbfabric: 'RTB Fabric only',
    both: 'Both (simultaneous)',
  }
  const statusLabels: Record<RunStatus, string> = {
    idle: 'idle',
    running: 'running',
    complete: 'complete',
    failed: 'failed',
    stopped: 'stopped',
  }
  // Surface the current run's mode and per-environment status so a failed or
  // one-sided run is never silently shown as a complete comparison
  // (Requirements 4.5, 4.8).
  $: runEnvs = $runState
    ? ENVS.filter((e) => $runState!.environments[e]).map((e) => ({
        env: e,
        ...$runState!.environments[e],
      }))
    : []
</script>

<section class="panel controls">
  <div class="row head">
    <h2>Run a comparison</h2>
    <button
      onclick={() => verify()}
      disabled={$busy === 'verify'}
      title="Check whether NLB and RTB Fabric are ready to run"
    >
      {$busy === 'verify' ? 'Verifying…' : 'Verify configuration'}
    </button>
  </div>

  <div class="readiness">
    {#each ENVS as env (env)}
      <div class="env-status" class:ready={ready(env)}>
        <div class="env-line">
          <span class="env-chip"><span class="env-swatch {env}"></span>{ENV_TOKENS[env].label}</span>
          <span class="status-pill {ready(env) ? 'ok' : 'pending'}">
            {ready(env) ? 'Ready' : verified ? 'Not ready' : 'Unverified'}
          </span>
          <span class="reason faint">{reasonFor(env)}</span>
        </div>
        {#if endpointFor(env)}
          <div class="endpoint">
            <span class="faint">detected endpoint</span>
            <span class="endpoint-box">
              <button
                class="copy-glyph"
                class:copied={copiedEnv === env}
                onclick={() => copyEndpoint(env)}
                aria-label={`Copy ${ENV_TOKENS[env].label} endpoint URL`}
              >
                {#if copiedEnv === env}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                {/if}
              </button>
              <code class="endpoint-url">{endpointFor(env)}</code>
              <span class="endpoint-tip" role="tooltip">{endpointFor(env)}</span>
            </span>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="row controls-row">
    <div class="field mode-field">
      <span class="label">Mode</span>
      <div class="segmented" role="group" aria-label="Run mode">
        {#each modes as m (m.value)}
          <button
            class="seg"
            class:active={mode === m.value}
            disabled={!verified || !avail[m.value] || $isRunning || autoActive}
            title={!avail[m.value] && verified ? 'Required environment(s) not ready' : ''}
            onclick={() => (mode = m.value)}
          >
            {m.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="field duration-field">
      <span class="label">Duration <strong>{formatDuration(duration)}</strong></span>
      <input
        type="range"
        min={DURATION.min}
        max={DURATION.max}
        step={DURATION.step}
        bind:value={duration}
        disabled={$isRunning}
        aria-label="Test duration"
      />
      <div class="range-ends faint">
        <span>{formatDuration(DURATION.min)}</span>
        <span>{formatDuration(DURATION.max)}</span>
      </div>
    </div>

    <div class="actions">
      <span class="run-wrap" title={runDisabled ? runHint() : ''}>
        <button class="primary" disabled={runDisabled} onclick={() => runTest(mode, duration)}>
          {$busy === 'run' ? 'Starting…' : 'Run'}
        </button>
      </span>
      <button class="danger" disabled={stopDisabled} onclick={() => stopTest()}>
        {$busy === 'stop' ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  </div>

  <div class="row fixed-params">
    <span class="faint">Fixed (server-side):</span>
    <span class="param"><span class="faint">rate</span> {formatRate($fixedParams.rate)} req/s</span>
    <span class="param"><span class="faint">devices</span> {$fixedParams.devices}</span>
    <span class="param"><span class="faint">workers</span> {$fixedParams.workers}</span>
  </div>

  {#if runEnvs.length}
    <div class="row run-status">
      <span class="faint">Run · {modeLabels[$runState?.mode ?? ''] ?? $runState?.mode}:</span>
      {#each runEnvs as r (r.env)}
        <span class="run-badge {r.status}">
          {ENV_TOKENS[r.env].label}: {statusLabels[r.status] ?? r.status}{#if r.error}
            — {r.error}{/if}
        </span>
      {/each}
    </div>
  {/if}

  {#if runDisabled && runHint()}
    <p class="hint faint">{runHint()}</p>
  {/if}
  {#if $actionError}
    <p class="hint error" role="alert">{$actionError}</p>
  {/if}
</section>

<style>
  .controls {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .head {
    justify-content: space-between;
  }

  .readiness {
    display: flex;
    gap: 28px;
    flex-wrap: wrap;
  }
  .env-status {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .env-line {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .endpoint {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78rem;
    max-width: 100%;
  }
  .endpoint-box {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 38ch;
    padding: 2px 8px;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  /* Copy affordance: a clipboard glyph at the start of the chip that swaps to a
     check on success. currentColor keeps it monochrome and theme-aware. */
  .copy-glyph {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .copy-glyph:hover {
    color: var(--text);
  }
  .copy-glyph.copied {
    color: var(--good);
  }
  .copy-glyph svg {
    width: 13px;
    height: 13px;
    display: block;
  }
  .endpoint-url {
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* Immediate (no-delay) tooltip with the full URL on hover, replacing the slow
     native title. word-break keeps a long URL inside the panel. */
  .endpoint-tip {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    display: none;
    width: max-content;
    max-width: min(560px, 80vw);
    padding: 6px 9px;
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text);
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    white-space: normal;
    word-break: break-all;
  }
  .endpoint-box:hover .endpoint-tip {
    display: block;
  }
  .status-pill {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .status-pill.ok {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 50%, transparent);
    background: color-mix(in srgb, var(--good) 12%, transparent);
  }
  .status-pill.pending {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
  }
  .reason {
    font-size: 0.8rem;
  }

  .controls-row {
    align-items: flex-end;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .duration-field {
    flex: 1;
    min-width: 220px;
  }
  .duration-field input[type='range'] {
    width: 100%;
    accent-color: var(--env-rtbfabric);
  }
  .range-ends {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .seg {
    border: none;
    border-radius: 0;
    background: var(--bg-panel-2);
    padding: 8px 12px;
    font-size: 0.85rem;
    border-right: 1px solid var(--border);
  }
  .seg:last-child {
    border-right: none;
  }
  .seg.active:not(:disabled) {
    background: color-mix(in srgb, var(--env-rtbfabric) 22%, var(--bg-panel-2));
    color: var(--text);
  }

  .actions {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .run-wrap {
    display: inline-flex;
  }
  .actions button {
    min-width: 84px;
  }

  .fixed-params {
    gap: 18px;
    font-size: 0.85rem;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
  .param {
    color: var(--text);
  }

  .hint {
    margin: 0;
    font-size: 0.82rem;
  }
  .hint.error {
    color: var(--bad);
  }

  .run-status {
    gap: 12px;
    font-size: 0.85rem;
  }
  .run-badge {
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .run-badge.running {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 50%, transparent);
  }
  .run-badge.complete {
    color: var(--text);
  }
  .run-badge.stopped {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .run-badge.failed {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 55%, transparent);
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }

  @media (max-width: 720px) {
    .controls-row {
      align-items: stretch;
    }
    .actions {
      justify-content: flex-end;
    }
  }
</style>
