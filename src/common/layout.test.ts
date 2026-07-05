import { describe, expect, test } from 'vitest'
import type { Tab } from './domain'
import { reconcilePanes, slotCount } from './layout'

const tab = (id: string, paneSlot: number | null = null): Tab => ({
  id,
  workspaceId: 'w',
  title: id,
  preset: 'shell',
  paneSlot,
  sortOrder: 0
})

describe('slotCount', () => {
  test('maps each layout to its pane count', () => {
    expect(slotCount('single')).toBe(1)
    expect(slotCount('columns')).toBe(2)
    expect(slotCount('rows')).toBe(2)
    expect(slotCount('grid')).toBe(4)
  })
})

describe('reconcilePanes', () => {
  test('single clears every pane slot (single view renders the active tab)', () => {
    const out = reconcilePanes([tab('a', 0), tab('b', 1)], 'single', 'a')
    expect(out).toEqual([
      { id: 'a', paneSlot: null },
      { id: 'b', paneSlot: null }
    ])
  })

  test('keeps in-range slots and clears out-of-range ones on shrink', () => {
    const out = reconcilePanes([tab('a', 0), tab('b', 3)], 'columns', 'a')
    expect(out).toEqual([
      { id: 'a', paneSlot: 0 },
      { id: 'b', paneSlot: null }
    ])
  })

  test('grid keeps all four slots', () => {
    const out = reconcilePanes([tab('a', 0), tab('b', 1), tab('c', 2), tab('d', 3)], 'grid', 'a')
    expect(out.map((r) => r.paneSlot)).toEqual([0, 1, 2, 3])
  })

  test('seeds slot 0 with the active tab when a multi-pane layout has no assignments', () => {
    const out = reconcilePanes([tab('a'), tab('b')], 'columns', 'b')
    expect(out).toEqual([
      { id: 'a', paneSlot: null },
      { id: 'b', paneSlot: 0 }
    ])
  })

  test('does not seed when some tab already occupies a slot', () => {
    const out = reconcilePanes([tab('a', 1), tab('b')], 'columns', 'b')
    expect(out).toEqual([
      { id: 'a', paneSlot: 1 },
      { id: 'b', paneSlot: null }
    ])
  })

  test('dedupes duplicate slot claims, keeping the first', () => {
    const out = reconcilePanes([tab('a', 0), tab('b', 0)], 'columns', 'a')
    expect(out).toEqual([
      { id: 'a', paneSlot: 0 },
      { id: 'b', paneSlot: null }
    ])
  })

  test('never places a deleted/absent active tab', () => {
    const out = reconcilePanes([tab('a'), tab('b')], 'columns', 'ghost')
    expect(out.every((r) => r.paneSlot === null)).toBe(true)
  })
})
