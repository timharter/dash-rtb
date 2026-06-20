<script lang="ts">
  // The workshop terminal (ttyd) is served at the distribution root, same-origin
  // to the dashboard under /dash/. We embed it in an iframe rather than
  // reimplementing a terminal (Requirement 8.2). The panel is resizable; ttyd's
  // xterm fit-addon reflows the PTY when the iframe element resizes
  // (Requirement 8.3). It runs on the workshop EC2 instance, not this pod
  // (Requirement 8.4).
  const TERMINAL_SRC = '/'

  let open = false
  const toggle = () => (open = !open)
</script>

<section class="panel terminal" class:open>
  <div class="term-head">
    <h2>Workshop terminal</h2>
    <button onclick={toggle} aria-expanded={open}>
      {open ? 'Hide terminal' : 'Open terminal'}
    </button>
  </div>

  {#if open}
    <div class="term-frame">
      <iframe src={TERMINAL_SRC} title="Workshop terminal" allow="clipboard-read; clipboard-write"
      ></iframe>
    </div>
    <p class="faint term-note">
      Drag the bottom-right corner to resize. Runs the shell on the workshop instance (repo,
      credentials, kubeconfig, and aliases).
    </p>
  {/if}
</section>

<style>
  .term-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .term-head h2 {
    margin: 0;
  }
  .term-frame {
    margin-top: 12px;
    /* User-resizable CloudShell-style panel; ttyd reflows to the new size. */
    resize: vertical;
    overflow: hidden;
    height: 380px;
    min-height: 180px;
    max-height: 80vh;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: #000;
  }
  .term-frame iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .term-note {
    margin: 8px 0 0;
    font-size: 0.75rem;
  }
</style>
