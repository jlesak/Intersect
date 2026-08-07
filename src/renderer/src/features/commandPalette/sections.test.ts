import { describe, expect, test } from 'vitest'
import type { Command } from '@renderer/shared/registries/commandRegistry'
import { paletteSections } from './sections'

const cmd = (id: string, title: string, group?: string): Command => ({
  id,
  title,
  group,
  handler: () => {}
})

const shape = (results: Command[], query: string): [string | null, string[]][] =>
  paletteSections(results, query).map((s) => [s.heading, s.commands.map((c) => c.id)])

describe('paletteSections', () => {
  test('a typed query keeps one flat section so ranking survives', () => {
    const results = [cmd('a', 'A', 'Tabs'), cmd('b', 'B', 'Terminal'), cmd('c', 'C', 'Tabs')]
    expect(shape(results, 'x')).toEqual([[null, ['a', 'b', 'c']]])
  })

  test('an empty query files commands under their group', () => {
    const results = [cmd('a', 'A', 'Tabs'), cmd('b', 'B', 'Terminal'), cmd('c', 'C', 'Tabs')]
    expect(shape(results, '')).toEqual([
      ['Tabs', ['a', 'c']],
      ['Terminal', ['b']]
    ])
  })

  test('groups are alphabetical, so registration order cannot move them', () => {
    const results = [cmd('a', 'A', 'Zulu'), cmd('b', 'B', 'Alpha'), cmd('c', 'C', 'Mike')]
    expect(shape(results, '').map(([heading]) => heading)).toEqual(['Alpha', 'Mike', 'Zulu'])
  })

  test('commands keep their given order inside a group', () => {
    const results = [cmd('a', 'A', 'Tabs'), cmd('b', 'B', 'Zulu'), cmd('c', 'C', 'Tabs')]
    expect(shape(results, '')[0]).toEqual(['Tabs', ['a', 'c']])
  })

  test('ungrouped commands land in Other, after every real group', () => {
    const results = [cmd('a', 'A'), cmd('b', 'B', 'Tabs'), cmd('c', 'C')]
    expect(shape(results, '')).toEqual([
      ['Tabs', ['b']],
      ['Other', ['a', 'c']]
    ])
  })

  test('no results is no sections, whether or not a query was typed', () => {
    expect(paletteSections([], 'x')).toEqual([])
    expect(paletteSections([], '')).toEqual([])
  })

  test('every command survives the split exactly once', () => {
    const results = [cmd('a', 'A', 'Tabs'), cmd('b', 'B'), cmd('c', 'C', 'Terminal')]
    const flat = paletteSections(results, '').flatMap((s) => s.commands.map((c) => c.id))
    expect(flat.sort()).toEqual(['a', 'b', 'c'])
  })

  test('a whitespace-only query groups, like an empty one', () => {
    const results = [cmd('a', 'A', 'Tabs')]
    expect(shape(results, '  ')).toEqual([['Tabs', ['a']]])
  })
})
