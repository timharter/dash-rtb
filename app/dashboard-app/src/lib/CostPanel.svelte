<script lang="ts">
  // Networking cost-savings visual. The same measured RTB traffic is priced
  // across traditional per-GB data-transfer paths (internet / cross-region /
  // cross-AZ / same-AZ) versus AWS RTB Fabric's per-transaction model, projected
  // to a daily/monthly figure. Report-driven: it populates once a run completes
  // and the authoritative byte/volume totals are in. All rate assumptions are
  // shown and editable so the comparison is transparent rather than asserted.
  import { finals } from './store'
  import { ENVS, type CompletionReport } from './contract'
  import {
    DEFAULT_RATES,
    PROJECTIONS,
    computeCosts,
    volumeFromReports,
    savingsPct,
    formatUSD,
    formatGB,
    formatCount,
    BYTES_PER_GB,
    type CostRates,
    type Projection,
  } from './cost'

  let rates: CostRates = { ...DEFAULT_RATES }
  let projId: Projection['id'] = 'month'
  let showAssumptions = false

  $: reports = ENVS.map((e) => $finals[e]).filter((r): r is CompletionReport => Boolean(r))
  $: vol = volumeFromReports(reports)
  $: projection = PROJECTIONS.find((p) => p.id === projId) ?? PROJECTIONS[2]
  $: result = computeCosts(vol, projection.seconds, rates)
  $: maxCost = Math.max(0, ...result.paths.map((p) => p.cost))
  $: gb = result.bytes / BYTES_PER_GB
  $: kbPerTxn = result.requests > 0 ? result.bytes / result.requests / 1024 : 0

  // Precompute the rows reactively (rather than reading result in the markup via
  // a function) so the bars/labels refresh on rate/projection changes.
  $: rows = result.paths.map((p) => ({
    id: p.id,
    label: p.label,
    note: p.note,
    costText: p.id === 'sameAz' && p.cost === 0 ? '$0 · free' : formatUSD(p.cost),
    widthPct: maxCost > 0 ? Math.max(p.cost > 0 ? 1.5 : 0, (p.cost / maxCost) * 100) : 0,
    isFabric: p.id === 'rtbfabric',
  }))

  $: fabricCost = result.paths.find((p) => p.id === 'rtbfabric')?.cost ?? 0
  $: internetCost = result.paths.find((p) => p.id === 'internet')?.cost ?? 0
  $: crossRegionCost = result.paths.find((p) => p.id === 'crossRegion')?.cost ?? 0
  $: saveVsInternet = savingsPct(internetCost, fabricCost)
  $: saveVsCrossRegion = savingsPct(crossRegionCost, fabricCost)
  $: periodWord = projection.id === 'run' ? 'this run' : projId === 'day' ? 'per day' : 'per month'

  function resetRates(): void {
    rates = { ...DEFAULT_RATES }
  }
</script>

<section class="panel cost">
  <div class="cost-head">
    <div class="cost-title">
      <h2>Networking cost</h2>
      <span class="faint">Same traffic, priced across each path — RTB Fabric replaces per-GB transfer with per-transaction pricing.</span>
    </div>
    <div class="toggle" role="group" aria-label="Projection period">
      {#each PROJECTIONS as p (p.id)}
        <button class="seg" class:active={projId === p.id} onclick={() => (projId = p.id)}>{p.label}</button>
      {/each}
    </div>
  </div>

  {#if !vol.ok}
    <div class="idle-state">
      Cost projection appears once a run completes — it is computed from the measured data volume.
    </div>
  {:else}
    <div class="savings">
      <div class="savings-figure">
        <span class="save-amt">{formatUSD(internetCost - fabricCost)}</span>
        <span class="save-cap">saved {periodWord} vs internet egress</span>
      </div>
      <div class="savings-meta">
        <span class="save-pct">{saveVsInternet.toFixed(0)}% lower than internet</span>
        <span class="faint">· {saveVsCrossRegion.toFixed(0)}% lower than cross-region</span>
      </div>
    </div>

    <div class="bars">
      {#each rows as r (r.id)}
        <div class="bar-row" class:fabric={r.isFabric}>
          <div class="bar-label">
            <span class="bar-name">{r.label}</span>
            {#if r.note}<span class="bar-note faint">{r.note}</span>{/if}
          </div>
          <div class="bar-track">
            <div class="bar-fill" class:fabric={r.isFabric} style="width: {r.widthPct}%"></div>
          </div>
          <span class="bar-cost" class:fabric={r.isFabric}>{r.costText}</span>
        </div>
      {/each}
    </div>

    <div class="basis faint">
      Measured ~{formatCount(vol.requestsPerSec)} req/s · {kbPerTxn.toFixed(2)} KB/round-trip →
      {formatGB(gb)} transferred · {formatCount(result.transactions)} transactions {periodWord}.
    </div>

    <div class="assumptions">
      <button class="link-btn" onclick={() => (showAssumptions = !showAssumptions)} aria-expanded={showAssumptions}>
        {showAssumptions ? '▾' : '▸'} Assumptions &amp; rates
      </button>
      {#if showAssumptions}
        <div class="assume-body">
          <div class="rate-grid">
            <label>Internet DTO ($/GB)<input type="number" min="0" step="0.01" bind:value={rates.internetPerGb} /></label>
            <label>Cross-region ($/GB)<input type="number" min="0" step="0.01" bind:value={rates.crossRegionPerGb} /></label>
            <label>Cross-AZ ($/GB)<input type="number" min="0" step="0.01" bind:value={rates.crossAzPerGb} /></label>
            <label>Same-AZ ($/GB)<input type="number" min="0" step="0.01" bind:value={rates.sameAzPerGb} /></label>
            <label class="fabric-rate">RTB Fabric ($/billion txn)<input type="number" min="0" step="1" bind:value={rates.rtbFabricPerBillionTxn} /></label>
            <button class="link-btn reset" onclick={resetRates}>Reset to defaults</button>
          </div>
          <p class="disclaimer faint">
            Illustrative estimate. Traditional rates are us-east-1 data-transfer list prices (both
            directions counted); GB = 10<sup>9</sup> bytes. RTB Fabric is billed per transaction
            (requests + responses), not per GB — its exact rate is volume/size tiered, so set it to
            your tier. Same-AZ transfer is free but only within a single account/AZ, which does not
            apply across AdTech partners — the realistic cross-partner baselines are internet and
            cross-region. See
            <a href="https://aws.amazon.com/rtb-fabric/pricing/" target="_blank" rel="noopener noreferrer">AWS RTB Fabric pricing</a>
            and the workshop's Ad-Tech Data Transfer Calculator for authoritative figures.
          </p>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .cost {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .cost-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .cost-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cost-title h2 {
    margin: 0;
  }
  .cost-title .faint {
    font-size: 0.78rem;
    max-width: 60ch;
  }
  .toggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    flex: none;
  }
  .seg {
    border: none;
    border-radius: 0;
    background: var(--bg-panel-2);
    padding: 5px 12px;
    font-size: 0.8rem;
    border-right: 1px solid var(--border);
  }
  .seg:last-child {
    border-right: none;
  }
  .seg.active {
    background: color-mix(in srgb, var(--env-rtbfabric) 24%, var(--bg-panel-2));
    color: var(--text);
  }

  /* Headline savings figure. */
  .savings {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--env-rtbfabric) 45%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--env-rtbfabric) 10%, transparent);
  }
  .savings-figure {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .save-amt {
    font-size: 1.9rem;
    font-weight: 750;
    line-height: 1;
    color: var(--env-rtbfabric);
    font-variant-numeric: tabular-nums;
  }
  .save-cap {
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .savings-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.82rem;
  }
  .save-pct {
    font-weight: 650;
    color: var(--good);
  }

  /* Proportional cost bars. */
  .bars {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 200px 1fr 120px;
    align-items: center;
    gap: 14px;
  }
  .bar-label {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .bar-name {
    font-size: 0.9rem;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .bar-row.fabric .bar-name {
    color: var(--text);
    font-weight: 650;
  }
  .bar-note {
    font-size: 0.68rem;
    line-height: 1.2;
  }
  .bar-track {
    height: 18px;
    background: color-mix(in srgb, var(--text) 6%, transparent);
    border-radius: 4px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--text-faint);
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .bar-fill.fabric {
    background: var(--env-rtbfabric);
  }
  .bar-cost {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .bar-cost.fabric {
    color: var(--env-rtbfabric);
  }

  .basis {
    font-size: 0.78rem;
  }

  .assumptions {
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--text-dim);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .link-btn:hover {
    color: var(--text);
  }
  .assume-body {
    margin-top: 10px;
  }
  .rate-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 18px;
    align-items: flex-end;
  }
  .rate-grid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .rate-grid input {
    width: 110px;
    padding: 5px 8px;
    font: inherit;
    font-size: 0.85rem;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
  }
  .rate-grid .fabric-rate {
    color: var(--env-rtbfabric);
  }
  .rate-grid .reset {
    padding-bottom: 6px;
  }
  .disclaimer {
    font-size: 0.72rem;
    line-height: 1.5;
    margin: 10px 0 0;
    max-width: 96ch;
  }
  .disclaimer a {
    color: var(--env-rtbfabric);
  }

  @media (max-width: 720px) {
    .bar-row {
      grid-template-columns: 130px 1fr 88px;
      gap: 8px;
    }
  }
</style>
