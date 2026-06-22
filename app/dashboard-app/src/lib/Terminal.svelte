<script lang="ts">
  import { terminalOpen } from './store'

  // The workshop terminal (ttyd) is served at the distribution root, same-origin
  // to the dashboard under /dash/. We embed it in an iframe rather than
  // reimplementing a terminal (Requirement 8.2). It runs on the workshop EC2
  // instance, not this pod (Requirement 8.4).
  //
  // CloudShell-style: a docked bottom drawer launched from the top bar, with a
  // drag handle on the top edge to resize it freely.
  const TERMINAL_SRC = '/'
  const MIN_HEIGHT = 160

  // Mount the iframe lazily on first open, then keep it mounted so the ttyd
  // shell session (cwd, history, running processes) survives close/reopen.
  let mounted = false
  $: if ($terminalOpen) mounted = true

  let drawerEl: HTMLDivElement
  // null => use the default CSS height; a number => user-dragged height in px.
  let heightPx: number | null = null
  let dragging = false

  const close = () => terminalOpen.set(false)

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && $terminalOpen) close()
  }

  // Drag the top edge to resize. Pointer capture keeps move/up events flowing to
  // the handle even when the cursor passes over the terminal iframe.
  function startResize(e: PointerEvent) {
    e.preventDefault()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    dragging = true
    const startY = e.clientY
    const startH = drawerEl.getBoundingClientRect().height
    const maxH = window.innerHeight * 0.95

    const onMove = (ev: PointerEvent) => {
      // Dragging up grows the drawer; down shrinks it.
      heightPx = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)))
    }
    const onUp = (ev: PointerEvent) => {
      dragging = false
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }
</script>

<svelte:window onkeydown={handleKey} />

<div
  class="term-drawer"
  class:open={$terminalOpen}
  class:dragging
  bind:this={drawerEl}
  style={heightPx !== null ? `height:${heightPx}px` : ''}
  role="dialog"
  aria-label="Workshop terminal"
  aria-hidden={!$terminalOpen}
>
  <div
    class="term-resize"
    onpointerdown={startResize}
    role="separator"
    aria-orientation="horizontal"
    aria-label="Drag to resize terminal"
    title="Drag to resize"
  ></div>
  <div class="term-bar">
    <div class="term-title">
      <span class="term-glyph" aria-hidden="true">›_</span>
      <span class="term-name">Workshop terminal</span>
    </div>
    <div class="term-actions">
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
    /* Slide on open/close; height is controlled directly (no transition) so the
       drag tracks the cursor instantly. */
    transform: translateY(100%);
    transition: transform 0.22s ease;
    pointer-events: none;
  }
  .term-drawer.open {
    transform: translateY(0);
    pointer-events: auto;
  }

  /* Drag handle along the top edge. */
  .term-resize {
    flex: 0 0 auto;
    height: 9px;
    cursor: ns-resize;
    background: var(--bg-panel-2);
    position: relative;
    touch-action: none;
  }
  .term-resize::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 42px;
    height: 3px;
    border-radius: 2px;
    background: var(--text-faint);
    opacity: 0.55;
  }
  .term-resize:hover::before {
    opacity: 1;
  }

  /* While dragging, keep the iframe from swallowing pointer events. */
  .term-drawer.dragging .term-body iframe {
    pointer-events: none;
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
  }
</style>
