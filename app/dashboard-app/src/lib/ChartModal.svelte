<script lang="ts">
  // Reusable fullscreen overlay for "blowing up" a chart. The chart instance
  // itself lives in the parent (charts are uPlot, bound to a specific DOM node),
  // so this component only provides the chrome: backdrop, titled panel, an
  // optional controls slot in the header, and close affordances (✕, Esc, and
  // backdrop click). The expanded chart goes in the default slot.
  export let title: string
  export let onClose: () => void

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose()
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- Backdrop click and the panel's stop-propagation are pointer enhancements;
     Escape and the ✕ button are the keyboard-accessible close paths. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal panel"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="modal-head">
      <h2>{title}</h2>
      <div class="modal-head-right">
        <slot name="controls" />
        <button class="close" onclick={onClose} aria-label="Close expanded chart" title="Close (Esc)">
          ✕
        </button>
      </div>
    </div>
    <div class="modal-body">
      <slot />
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(4, 9, 20, 0.72);
    backdrop-filter: blur(2px);
  }
  .modal {
    width: min(96vw, 1500px);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .modal-head h2 {
    margin: 0;
  }
  .modal-head-right {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    font-size: 0.95rem;
    line-height: 1;
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
</style>
