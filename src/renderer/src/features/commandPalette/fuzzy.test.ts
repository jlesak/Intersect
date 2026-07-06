import { describe, expect, test } from 'vitest'
import type { Command } from '@renderer/shared/registries/commandRegistry'
import { filterCommands } from './fuzzy'

const cmd = (id: string, title: string): Command => ({ id, title, handler: () => {} })

const commands: Command[] = [
  cmd('workspaces.create', 'Add Workspace'),
  cmd('tabs.newShell', 'New Shell Tab'),
  cmd('tabs.newClaude', 'New Claude Code Tab'),
  cmd('terminal.layoutSingle', 'Layout: Single'),
  cmd('terminal.layoutGrid', 'Layout: 2×2 Grid')
]

const titles = (result: Command[]): string[] => result.map((c) => c.title)

describe('filterCommands', () => {
  test('empty query returns every command in the given order', () => {
    expect(filterCommands('', commands)).toEqual(commands)
  })

  test('whitespace-only query is treated as empty', () => {
    expect(filterCommands('   ', commands)).toEqual(commands)
  })

  test('matches a query as a case-insensitive subsequence of the title', () => {
    // "nsh" -> "New SHell Tab"
    expect(titles(filterCommands('nsh', commands))).toEqual(['New Shell Tab'])
  })

  test('matching is case-insensitive both ways', () => {
    expect(titles(filterCommands('ADD', commands))).toContain('Add Workspace')
    expect(titles(filterCommands('layout', commands))).toEqual(
      expect.arrayContaining(['Layout: Single', 'Layout: 2×2 Grid'])
    )
  })

  test('excludes commands whose title is not a supersequence of the query', () => {
    const result = titles(filterCommands('zzz', commands))
    expect(result).toEqual([])
  })

  test('a contiguous substring match ranks above a scattered subsequence match', () => {
    const items = [cmd('a', 'Layer Cake Tool'), cmd('b', 'Layout: Single')]
    // "layo" is contiguous in "Layout", scattered in "LAYer cake tOol".
    expect(titles(filterCommands('layo', items))).toEqual(['Layout: Single', 'Layer Cake Tool'])
  })

  test('an earlier match ranks above a later one when equally contiguous', () => {
    const items = [cmd('a', 'New Tab'), cmd('b', 'Tab New')]
    expect(titles(filterCommands('tab', items))).toEqual(['Tab New', 'New Tab'])
  })

  test('a word-boundary match ranks above a mid-word match', () => {
    const items = [cmd('a', 'Insert Rows'), cmd('b', 'Rows Above')]
    // Query "rows": word-start in "Rows Above", also word-start in "Insert Rows";
    // tie broken by earlier position -> but both start at boundary, earlier wins.
    expect(titles(filterCommands('rows', items))).toEqual(['Rows Above', 'Insert Rows'])
  })

  test('does not mutate the input array', () => {
    const input = [...commands]
    filterCommands('new', input)
    expect(input).toEqual(commands)
  })
})
