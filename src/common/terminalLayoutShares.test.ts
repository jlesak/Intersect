import { describe, expect, test } from 'vitest'
import {
  equalShares,
  isResizableLayout,
  normalizeShares,
  sharesEqual
} from './terminalLayoutShares'

describe('equalShares', () => {
  test('columns and rows split 50/50', () => {
    expect(equalShares('columns')).toEqual([50, 50])
    expect(equalShares('rows')).toEqual([50, 50])
  })

  test('grid splits every axis 50/50', () => {
    expect(equalShares('grid')).toEqual({
      columns: [50, 50],
      leftRows: [50, 50],
      rightRows: [50, 50]
    })
  })

  test('returns a fresh value each call so callers can never share mutable state', () => {
    const a = equalShares('columns')
    const b = equalShares('columns')
    expect(a).not.toBe(b)
    expect(equalShares('grid').columns).not.toBe(equalShares('grid').columns)
  })
})

describe('isResizableLayout', () => {
  test('accepts the three multi-pane layouts and rejects single', () => {
    expect(isResizableLayout('columns')).toBe(true)
    expect(isResizableLayout('rows')).toBe(true)
    expect(isResizableLayout('grid')).toBe(true)
    expect(isResizableLayout('single')).toBe(false)
    expect(isResizableLayout('bogus')).toBe(false)
  })
})

describe('normalizeShares for pairs', () => {
  test('keeps an already valid split', () => {
    expect(normalizeShares('columns', [70, 30])).toEqual([70, 30])
  })

  test('rescales finite positive values to sum exactly 100', () => {
    expect(normalizeShares('rows', [1, 3])).toEqual([25, 75])
    expect(normalizeShares('rows', [140, 60])).toEqual([70, 30])
  })

  test('the second share absorbs the rounding remainder so the sum is exactly 100', () => {
    const [a, b] = normalizeShares('columns', [1, 2])
    expect(a).toBe(33.3333)
    expect(b).toBe(66.6667)
    expect(a + b).toBe(100)
  })

  test('clamps either side to the 10% minimum', () => {
    expect(normalizeShares('columns', [5, 95])).toEqual([10, 90])
    expect(normalizeShares('columns', [95, 5])).toEqual([90, 10])
  })

  test.each([
    ['absent', undefined],
    ['null', null],
    ['not an array', { 0: 70, 1: 30 }],
    ['wrong length', [70, 20, 10]],
    ['non-numeric entries', ['70', '30']],
    ['NaN', [NaN, 30]],
    ['Infinity', [Infinity, 30]],
    ['zero share', [0, 100]],
    ['negative share', [-10, 110]]
  ])('falls back to equal shares for a corrupt value: %s', (_name, value) => {
    expect(normalizeShares('columns', value)).toEqual([50, 50])
  })
})

describe('normalizeShares for grid', () => {
  test('keeps a valid grid shape and normalizes each axis independently', () => {
    expect(
      normalizeShares('grid', {
        columns: [70, 30],
        leftRows: [1, 3],
        rightRows: [5, 95]
      })
    ).toEqual({
      columns: [70, 30],
      leftRows: [25, 75],
      rightRows: [10, 90]
    })
  })

  test('a corrupt axis inside an otherwise valid grid degrades only that axis', () => {
    expect(
      normalizeShares('grid', { columns: [60, 40], leftRows: 'oops', rightRows: [30, 70] })
    ).toEqual({ columns: [60, 40], leftRows: [50, 50], rightRows: [30, 70] })
  })

  test.each([
    ['absent', undefined],
    ['null', null],
    ['a pair persisted under grid', [70, 30]],
    ['a primitive', 42]
  ])('falls back to the equal grid for an incompatible value: %s', (_name, value) => {
    expect(normalizeShares('grid', value)).toEqual(equalShares('grid'))
  })

  test('a pair layout given a grid object falls back to equal shares', () => {
    expect(
      normalizeShares('columns', { columns: [70, 30], leftRows: [50, 50], rightRows: [50, 50] })
    ).toEqual([50, 50])
  })
})

describe('sharesEqual', () => {
  test('pairs match within the epsilon and differ beyond it', () => {
    expect(sharesEqual([70, 30], [70.005, 29.995])).toBe(true)
    expect(sharesEqual([70, 30], [69, 31])).toBe(false)
  })

  test('grids compare every axis', () => {
    const a = equalShares('grid')
    expect(sharesEqual(a, equalShares('grid'))).toBe(true)
    expect(sharesEqual(a, { ...equalShares('grid'), rightRows: [40, 60] })).toBe(false)
  })

  test('a pair never equals a grid', () => {
    expect(sharesEqual([50, 50], equalShares('grid'))).toBe(false)
  })
})
