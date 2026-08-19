import { describe, expect, test } from 'vitest'
import { LAYOUTS, type Layout, type Tab } from './domain'
import { regroupTabs, remapSlots, slotCount, toolsSlot, visibleTabOf } from './layout'

const tab = (id: string, paneSlot = 0, sortOrder = 0, lastActiveAt: number | null = null): Tab => ({
  id,
  workspaceId: 'w',
  title: id,
  preset: 'shell',
  paneSlot,
  sortOrder,
  lastActiveAt,
  resumeSessionId: null,
  sessionStatus: null,
  suspendReason: null,
  suspendedAt: null
})

/** Placements as `id@slot:order`, which reads as a bar layout at a glance. */
const placed = (tabs: Tab[], from: Layout, to: Layout): string[] =>
  regroupTabs(tabs, from, to).map((a) => `${a.id}@${a.paneSlot}:${a.sortOrder}`)

describe('slotCount', () => {
  test('maps each layout to its pane count', () => {
    expect(slotCount('single')).toBe(1)
    expect(slotCount('columns')).toBe(2)
    expect(slotCount('rows')).toBe(2)
    expect(slotCount('grid')).toBe(4)
  })
})

describe('toolsSlot', () => {
  test('is the top-right group of each layout', () => {
    expect(toolsSlot('single')).toBe(0)
    expect(toolsSlot('columns')).toBe(1)
    expect(toolsSlot('rows')).toBe(0)
    expect(toolsSlot('grid')).toBe(1)
  })

  test('always names a group the layout actually has', () => {
    for (const layout of LAYOUTS) expect(toolsSlot(layout)).toBeLessThan(slotCount(layout))
  })
})

describe('remapSlots', () => {
  const table: [Layout, Layout, number[]][] = [
    ['single', 'single', [0]],
    ['single', 'columns', [0]],
    ['single', 'rows', [0]],
    ['single', 'grid', [0]],
    ['columns', 'single', [0, 0]],
    ['columns', 'columns', [0, 1]],
    ['columns', 'rows', [0, 1]],
    ['columns', 'grid', [0, 1]],
    ['rows', 'single', [0, 0]],
    ['rows', 'columns', [0, 1]],
    ['rows', 'rows', [0, 1]],
    // The bottom row is the grid's bottom-left pane, which is slot 2.
    ['rows', 'grid', [0, 2]],
    ['grid', 'single', [0, 0, 0, 0]],
    ['grid', 'columns', [0, 1, 0, 1]],
    ['grid', 'rows', [0, 0, 1, 1]],
    ['grid', 'grid', [0, 1, 2, 3]]
  ]

  test.each(table)('%s -> %s maps to %j', (from, to, expected) => {
    expect(remapSlots(from, to)).toEqual(expected)
  })

  test('the table covers every from/to pair', () => {
    expect(table).toHaveLength(LAYOUTS.length * LAYOUTS.length)
  })

  test('never names a group outside the target layout', () => {
    for (const from of LAYOUTS) {
      for (const to of LAYOUTS) {
        const map = remapSlots(from, to)
        expect(map).toHaveLength(slotCount(from))
        for (const slot of map) expect(slot).toBeLessThan(slotCount(to))
      }
    }
  })

  test('a layout mapped onto itself is the identity, so a no-op switch moves nothing', () => {
    for (const layout of LAYOUTS) {
      expect(remapSlots(layout, layout)).toEqual(
        Array.from({ length: slotCount(layout) }, (_, i) => i)
      )
    }
  })
})

describe('regroupTabs', () => {
  test('grid -> columns appends the right column below the left one, order preserved', () => {
    const tabs = [
      tab('a', 0, 0),
      tab('b', 0, 1),
      tab('c', 1, 0),
      tab('d', 2, 0),
      tab('e', 2, 1),
      tab('f', 3, 0)
    ]
    // Grid slot 2 folds into column 0 behind a and b; slot 3 folds into column 1 behind c.
    expect(placed(tabs, 'grid', 'columns')).toEqual([
      'a@0:0',
      'b@0:1',
      'd@0:2',
      'e@0:3',
      'c@1:0',
      'f@1:1'
    ])
  })

  test('grid -> rows folds by row: the top pair into row 0, the bottom pair into row 1', () => {
    const tabs = [tab('a', 0, 0), tab('b', 1, 0), tab('c', 2, 0), tab('d', 3, 0)]
    expect(placed(tabs, 'grid', 'rows')).toEqual(['a@0:0', 'b@0:1', 'c@1:0', 'd@1:1'])
  })

  test('anything -> single collapses every group into one bar in screen order', () => {
    const grid = [tab('a', 0, 0), tab('b', 1, 0), tab('c', 2, 0), tab('d', 3, 0)]
    expect(placed(grid, 'grid', 'single')).toEqual(['a@0:0', 'b@0:1', 'c@0:2', 'd@0:3'])
    const rows = [tab('x', 1, 0), tab('y', 0, 0)]
    expect(placed(rows, 'rows', 'single')).toEqual(['y@0:0', 'x@0:1'])
  })

  test('growing keeps every tab where it is and leaves the new groups empty', () => {
    const tabs = [tab('a', 0, 0), tab('b', 1, 0)]
    expect(placed(tabs, 'columns', 'grid')).toEqual(['a@0:0', 'b@1:0'])
    expect(placed(tabs, 'rows', 'grid')).toEqual(['a@0:0', 'b@2:0'])
  })

  test('sortOrder is renumbered densely from 0 inside each group', () => {
    const tabs = [tab('a', 0, 7), tab('b', 0, 12), tab('c', 1, 4)]
    expect(placed(tabs, 'columns', 'columns')).toEqual(['a@0:0', 'b@0:1', 'c@1:0'])
  })

  test('a slot outside the target layout clamps into the last group', () => {
    // A stale slot 3 on a workspace already in `columns` still has to land somewhere.
    expect(placed([tab('a', 0, 0), tab('stale', 3, 0)], 'columns', 'columns')).toEqual([
      'a@0:0',
      'stale@1:0'
    ])
    expect(placed([tab('stale', 9, 0)], 'single', 'single')).toEqual(['stale@0:0'])
  })

  test('an empty workspace regroups to nothing', () => {
    expect(regroupTabs([], 'grid', 'single')).toEqual([])
  })
})

describe('visibleTabOf', () => {
  test('the most recently activated tab of the group is the one it shows', () => {
    const shown = visibleTabOf([tab('a', 0, 0, 100), tab('b', 0, 1, 900), tab('c', 0, 2, 400)])
    expect(shown?.id).toBe('b')
  })

  test('any activated tab beats a never-activated one, whatever the bar order', () => {
    const shown = visibleTabOf([tab('a', 0, 0, null), tab('b', 0, 1, 5)])
    expect(shown?.id).toBe('b')
  })

  test('a group nobody has touched shows its first tab in bar order', () => {
    const shown = visibleTabOf([tab('b', 0, 2), tab('a', 0, 0), tab('c', 0, 1)])
    expect(shown?.id).toBe('a')
  })

  test('tabs stamped at the same instant resolve to the first one in the group', () => {
    // Migration 27 stamps a whole group with one timestamp, so the tie has to be stable.
    const shown = visibleTabOf([tab('a', 0, 0, 42), tab('b', 0, 1, 42)])
    expect(shown?.id).toBe('a')
  })

  test('an empty group shows nothing', () => {
    expect(visibleTabOf([])).toBeUndefined()
  })
})
