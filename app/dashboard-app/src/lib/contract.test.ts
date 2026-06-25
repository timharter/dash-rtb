import { describe, it, expect } from 'vitest'
import {
  nsToMs,
  formatMs,
  formatErrorPct,
  formatRate,
  formatInt,
  formatDuration,
  durationToGo,
  lowerIsBetterDelta,
  parseBucketBounds,
  addBuckets,
  buildCdf,
  unionSorted,
} from './contract'

describe('nsToMs', () => {
  it('converts nanoseconds to milliseconds', () => {
    expect(nsToMs(1_000_000)).toBe(1)
    expect(nsToMs(2_500_000)).toBe(2.5)
    expect(nsToMs(0)).toBe(0)
  })

  it('treats null/undefined/NaN as 0', () => {
    expect(nsToMs(null)).toBe(0)
    expect(nsToMs(undefined)).toBe(0)
    expect(nsToMs(Number.NaN)).toBe(0)
  })
})

describe('formatMs', () => {
  it('rounds to whole ms at or above 100', () => {
    expect(formatMs(150)).toBe('150 ms')
    expect(formatMs(100)).toBe('100 ms')
  })

  it('keeps one decimal below 100', () => {
    expect(formatMs(3.34)).toBe('3.3 ms')
    expect(formatMs(12.5)).toBe('12.5 ms')
    expect(formatMs(99)).toBe('99.0 ms')
  })

  it('renders a dash for missing values', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(undefined)).toBe('—')
    expect(formatMs(Number.NaN)).toBe('—')
  })
})

describe('formatErrorPct', () => {
  it('converts a 0..1 success ratio to an error percentage', () => {
    expect(formatErrorPct(1)).toBe('0.00%')
    expect(formatErrorPct(0.99)).toBe('1.00%')
    expect(formatErrorPct(0.95)).toBe('5.00%')
  })

  it('renders a dash for missing values', () => {
    expect(formatErrorPct(null)).toBe('—')
    expect(formatErrorPct(undefined)).toBe('—')
  })
})

describe('formatRate / formatInt', () => {
  it('rounds and groups thousands', () => {
    expect(formatRate(1000)).toBe('1,000')
    expect(formatRate(1234.6)).toBe('1,235')
    expect(formatInt(1000)).toBe('1,000')
    expect(formatInt(0)).toBe('0')
  })

  it('renders a dash for missing values', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatInt(undefined)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(90)).toBe('1m 30s')
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(300)).toBe('5m')
    expect(formatDuration(0)).toBe('0s')
  })
})

describe('durationToGo', () => {
  it('appends the Go seconds suffix', () => {
    expect(durationToGo(300)).toBe('300s')
    expect(durationToGo(60)).toBe('60s')
  })
})

describe('lowerIsBetterDelta', () => {
  it('marks RTB Fabric better when it is meaningfully lower', () => {
    const d = lowerIsBetterDelta(100, 80)
    expect(d.direction).toBe('better')
    expect(d.text).toContain('20%')
    expect(d.text).toContain('vs NLB')
    expect(d.text.startsWith('+')).toBe(false) // a reduction, not an increase
  })

  it('marks RTB Fabric worse when it is meaningfully higher', () => {
    const d = lowerIsBetterDelta(80, 100)
    expect(d.direction).toBe('worse')
    expect(d.text).toContain('25%')
    expect(d.text.startsWith('+')).toBe(true)
  })

  it('is neutral when the two are equal', () => {
    expect(lowerIsBetterDelta(50, 50).direction).toBe('neutral')
  })

  it('is neutral for invalid inputs (NLB zero or missing)', () => {
    expect(lowerIsBetterDelta(0, 5)).toEqual({ text: '—', direction: 'neutral' })
    expect(lowerIsBetterDelta(null, 5)).toEqual({ text: '—', direction: 'neutral' })
    expect(lowerIsBetterDelta(100, undefined)).toEqual({ text: '—', direction: 'neutral' })
  })
})

describe('parseBucketBounds', () => {
  it('parses a finite "lo-hi" label', () => {
    expect(parseBucketBounds('3-4.5')).toEqual({ lo: 3, hi: 4.5 })
  })

  it('parses the open-ended overflow label', () => {
    expect(parseBucketBounds('100-+Inf')).toEqual({ lo: 100, hi: Infinity })
  })

  it('treats a bare number as an open-ended lower edge', () => {
    expect(parseBucketBounds('5')).toEqual({ lo: 5, hi: Infinity })
  })

  it('falls back safely on an unparseable label', () => {
    expect(parseBucketBounds('abc')).toEqual({ lo: 0, hi: Infinity })
  })
})

describe('addBuckets', () => {
  it('sums src counts into dst in place', () => {
    const dst: Record<string, number> = { a: 1, b: 2 }
    addBuckets(dst, { b: 3, c: 4 })
    expect(dst).toEqual({ a: 1, b: 5, c: 4 })
  })
})

describe('buildCdf', () => {
  it('builds a cumulative curve anchored at 0% and reaching 100%', () => {
    const cdf = buildCdf({ '1-2': 50, '2-3': 50 })
    expect(cdf.x).toEqual([1, 2, 3])
    expect(cdf.y).toEqual([0, 50, 100])
  })

  it('returns empty curves when there are no samples', () => {
    expect(buildCdf({})).toEqual({ x: [], y: [] })
    expect(buildCdf({ '1-2': 0 })).toEqual({ x: [], y: [] })
  })

  it('counts the open-ended bucket only in the denominator, so the curve honestly stops short of 100%', () => {
    const cdf = buildCdf({ '1-2': 50, '2-+Inf': 50 })
    expect(cdf.x).toEqual([1, 2])
    expect(cdf.y).toEqual([0, 50]) // half the mass is in the overflow tail
  })
})

describe('unionSorted', () => {
  it('merges, deduplicates, and sorts', () => {
    expect(unionSorted([3, 1, 2], [2, 5])).toEqual([1, 2, 3, 5])
    expect(unionSorted([], [])).toEqual([])
  })
})
