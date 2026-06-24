// Small uPlot zoom helpers shared by the latency charts. Both charts enable
// uPlot's built-in drag-to-zoom on the x-axis; these let the UI show a "reset
// zoom" affordance and reset programmatically (the same effect as uPlot's
// built-in double-click), so the two charts behave identically.
import type uPlot from 'uplot'

/** True when the x-scale is zoomed tighter than the full data extent. */
export function isXZoomed(u: uPlot): boolean {
  const d = u.data[0] as readonly number[] | undefined
  if (!d || d.length < 2) return false
  const lo = d[0]
  const hi = d[d.length - 1]
  const span = hi - lo
  if (!(span > 0)) return false
  const eps = span * 0.005
  return (u.scales.x.min ?? lo) > lo + eps || (u.scales.x.max ?? hi) < hi - eps
}

/** Resets the x-scale to the full data extent, clearing a drag-zoom. */
export function resetXZoom(u: uPlot | null): void {
  if (!u) return
  const d = u.data[0] as readonly number[] | undefined
  if (d && d.length >= 2) u.setScale('x', { min: d[0], max: d[d.length - 1] })
}
