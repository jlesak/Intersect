import { describe, expect, test } from 'vitest'
import { fuzzyFilter, scoreMatch } from './fuzzy'

describe('scoreMatch', () => {
  test('matches a subsequence case-insensitively and rejects a non-subsequence', () => {
    expect(scoreMatch('rvw', 'reviewer')).not.toBeNull()
    expect(scoreMatch('xyz', 'reviewer')).toBeNull()
  })

  test('scores a contiguous prefix match higher than a scattered one', () => {
    const contiguous = scoreMatch('rev', 'reviewer')!
    const scattered = scoreMatch('rer', 'reviewer')!
    expect(contiguous).toBeGreaterThan(scattered)
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { name: 'reviewer', desc: 'reviews code' },
    { name: 'builder', desc: 'builds things' },
    { name: 'planner', desc: 'plans work' }
  ]
  const textOf = (i: (typeof items)[number]): string[] => [i.name, i.desc]

  test('an empty query returns every item in original order', () => {
    expect(fuzzyFilter('', items, textOf)).toEqual(items)
  })

  test('filters to items matching the query in any searchable field', () => {
    const result = fuzzyFilter('code', items, textOf)
    expect(result.map((i) => i.name)).toEqual(['reviewer'])
  })

  test('ranks a name match ahead of a description-only match', () => {
    const result = fuzzyFilter('build', items, textOf)
    expect(result[0]?.name).toBe('builder')
  })
})
