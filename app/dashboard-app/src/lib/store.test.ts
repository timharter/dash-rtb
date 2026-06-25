import { describe, it, expect } from 'vitest'
import { meanOf, stdDevOf } from './store'

describe('meanOf', () => {
  it('computes the arithmetic mean', () => {
    expect(meanOf([2, 4, 6])).toBe(4)
    expect(meanOf([10])).toBe(10)
  })

  it('returns 0 for an empty sample', () => {
    expect(meanOf([])).toBe(0)
  })
})

describe('stdDevOf', () => {
  it('computes the sample standard deviation (n-1)', () => {
    // mean 3; squared deviations 1 + 1 = 2; /(2-1) = 2; sqrt = √2.
    expect(stdDevOf([2, 4])).toBeCloseTo(Math.SQRT2, 10)
  })

  it('is 0 when all samples are identical', () => {
    expect(stdDevOf([1, 1, 1])).toBe(0)
  })

  it('is 0 for fewer than two samples', () => {
    expect(stdDevOf([5])).toBe(0)
    expect(stdDevOf([])).toBe(0)
  })
})
