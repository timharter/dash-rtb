<script lang="ts">
  import { terminalOpen } from './store'

  // The workshop terminal (ttyd) is served at the distribution root, same-origin
  // to the dashboard under /dash/. We embed it in an iframe rather than
  // reimplementing a terminal (Requirement 8.2). It runs on the workshop EC2
  // instance, not this pod (Requirement 8.4).
  //
  // CloudShell-style: the terminal is a docked bottom drawer launched from the
  // top bar. It is the primary interaction surface for the first half of the
  // workshop, so it overlays the dashboard and can be maximized.
  const TERMINAL_SRC = '/'

  let maximized = false

  // Mount the iframe lazily on first open, then keep it mounted so the ttyd
  // shell session (cwd, history, running processes) survives close/reopen.
  let mounted = false
  $: if ($terminalOpen) mounted = true

  const close = () => terminalOpen.set(false)
  const toggleMax = () => (maximized = !maximized)

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && $terminalOpen) close()
  }
</script>

<svelte:window onkeydown={handleKey} />

<div
  class="term-drawer"
  class:open={$terminalOpen}
  class:maximized
  role="dialog"
  aria-label="Workshop terminal"
  aria-hidden={!$terminalOpen}
>
  <div class="term-bar">
    <div class="term-title">
      <span class="term-glyph" aria-hidden="true">›_</span>
      <span class="term-name">Workshop terminal</span>
      <span class="faint term-hint">shell on the workshop instance — repo, credentials, kubeconfig, aliases</span>
    </div>
    <div class="term-actions">
      <button
        class="icon-btn"
        onclick={toggleMax}
        aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? '⤡' : '⤢'}
      </button>
      <button class="icon-btn" onclick={close} aria-label="Close terminal" title="Close (Esc)">✕</button>
    </div>
  </div>
  <div class="term-body">
    {#if mounted}
      <iframe src={TERMINAL_SRC} title="Workshop terminal" allow="clipboard-read; clipboard-write"
      ></iframe>
    {/if}
  </div>
</div>

<style>
  .term-drawer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 60;
    height: 46vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    box-shadow: 0 -16px 40px rgba(0, 0, 0, 0.45);
    /* Docked off-screen until opened; slide up on open. The iframe stays mounted
       so the shell session is preserved while hidden. */
    transform: translateY(100%);
    transition: transform 0.22s ease, height 0.18s ease;
    pointer-events: none;
  }
  .term-drawer.open {
    transform: translateY(0);
    pointer-events: auto;
  }
  .term-drawer.maximized {
    height: 92vh;
  }

  .term-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-panel-2);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .term-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .term-glyph {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: var(--env-rtbfabric);
  }
  .term-name {
    font-weight: 650;
    font-size: 0.9rem;
  }
  .term-hint {
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .term-actions {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .icon-btn {
    padding: 4px 10px;
    line-height: 1;
    font-size: 0.95rem;
    background: transparent;
  }

  .term-body {
    flex: 1 1 auto;
    min-height: 0;
    background: #000;
  }
  .term-body iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }

  @media (max-width: 720px) {
    .term-drawer {
      height: 60vh;
    }
    .term-hint {
      display: none;
    }
  }
</style>
