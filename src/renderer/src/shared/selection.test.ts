import { describe, expect, test } from 'vitest'
import {
  NO_VALUE,
  dimensionValues,
  matchesSelection,
  reconcileSelection,
  toggleSelection,
  withNoneOption
} from './selection'

const ALL = ['a', 'b', 'c']

describe('matchesSelection', () => {
  test('an untouched control hides nothing, not even an item carrying no values', () => {
    expect(matchesSelection(null, [])).toBe(true)
    expect(matchesSelection(null, ['a'])).toBe(true)
  })

  test('an item survives on any one of the chosen values', () => {
    expect(matchesSelection(['a'], ['b', 'a'])).toBe(true)
    expect(matchesSelection(['a'], ['b'])).toBe(false)
  })

  test('an item carrying no values at all is out once the control has been narrowed', () => {
    expect(matchesSelection(['a'], [])).toBe(false)
    expect(matchesSelection([], ['a'])).toBe(false)
  })
})

describe('toggleSelection', () => {
  test('unticking one value out of "all" leaves the rest', () => {
    expect(toggleSelection(null, 'b', ALL)).toEqual(['a', 'c'])
  })

  test('ticking the last missing value goes back to "all" rather than listing every value', () => {
    expect(toggleSelection(['a', 'c'], 'b', ALL)).toBeNull()
  })

  test('ticking and unticking within a narrowed selection keeps it narrow', () => {
    expect(toggleSelection([], 'a', ALL)).toEqual(['a'])
    expect(toggleSelection(['a', 'b'], 'a', ALL)).toEqual(['b'])
  })
})

describe('reconcileSelection', () => {
  test('a dimension with nothing to choose between constrains nothing', () => {
    // The control that set this is not drawn at all, so nothing on screen could take it back.
    expect(reconcileSelection(['a'], [])).toBeNull()
    expect(reconcileSelection([], [])).toBeNull()
  })

  test('a value that is no longer on offer is dropped, and the rest still constrain', () => {
    expect(reconcileSelection(['a', 'gone'], ALL)).toEqual(['a'])
  })

  test('a selection the user emptied stays empty while the control is still there to undo it', () => {
    expect(reconcileSelection([], ALL)).toEqual([])
  })

  test('an untouched selection is left untouched', () => {
    expect(reconcileSelection(null, ALL)).toBeNull()
    expect(reconcileSelection(null, [])).toBeNull()
  })
})

describe('dimensionValues', () => {
  test('an item with values is described by them', () => {
    expect(dimensionValues(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('an item with none is described by the stand-in, so it can be ticked like anything else', () => {
    expect(dimensionValues([])).toEqual([NO_VALUE])
    expect(matchesSelection([NO_VALUE], dimensionValues([]))).toBe(true)
    expect(matchesSelection(['a'], dimensionValues([]))).toBe(false)
  })
})

describe('withNoneOption', () => {
  const options = [{ value: 'a', label: 'a' }]

  test('items lacking the value earn a "(none)" choice of their own', () => {
    expect(withNoneOption(options, true)).toEqual([
      { value: 'a', label: 'a' },
      { value: NO_VALUE, label: '(none)' }
    ])
  })

  test('a dimension every item carries offers no "(none)"', () => {
    expect(withNoneOption(options, false)).toEqual(options)
  })

  test('a dimension no item carries offers nothing at all, not a lone "(none)"', () => {
    expect(withNoneOption([], true)).toEqual([])
  })
})

describe('toggleSelection over a dimension that has a "(none)" choice', () => {
  const withNone = ['a', 'b', NO_VALUE]

  test('unticking one value keeps "(none)" ticked, so items with no value stay put', () => {
    const next = toggleSelection(null, 'a', withNone)
    expect(next).toEqual(['b', NO_VALUE])
    expect(matchesSelection(next, dimensionValues([]))).toBe(true)
    expect(matchesSelection(next, ['a'])).toBe(false)
  })

  test('"(none)" can be asked for on its own', () => {
    expect(matchesSelection([NO_VALUE], dimensionValues([]))).toBe(true)
    expect(matchesSelection([NO_VALUE], ['a'])).toBe(false)
  })
})
