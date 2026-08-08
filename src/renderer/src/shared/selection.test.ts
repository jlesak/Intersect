import { describe, expect, test } from 'vitest'
import { matchesSelection, toggleSelection } from './selection'

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
