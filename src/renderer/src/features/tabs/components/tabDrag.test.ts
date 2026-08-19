import { describe, expect, test } from 'vitest'
import {
  dropIndexAt,
  dropTargetIndex,
  isTabDrag,
  readTabDrag,
  TAB_DRAG_MIME,
  writeTabDrag,
  type TabTransfer
} from './tabDrag'

/** A DataTransfer stand-in: jsdom has none to construct, and these helpers only need the map. */
function transfer(seed: Record<string, string> = {}): TabTransfer {
  const data = { ...seed }
  return {
    get types() {
      return Object.keys(data)
    },
    getData: (type) => data[type] ?? '',
    setData: (type, value) => {
      data[type] = value
    }
  }
}

/** Equal-width tabs laid out end to end from x = 0, which is what a strip measures as. */
const strip = (count: number, width = 100): { left: number; width: number }[] =>
  Array.from({ length: count }, (_, i) => ({ left: i * width, width }))

describe('tab drag payload', () => {
  test('a written drag reads back as the tab and the group it left', () => {
    const dt = transfer()
    writeTabDrag(dt, { id: 't2', slot: 1 })

    expect(isTabDrag(dt)).toBe(true)
    expect(readTabDrag(dt)).toEqual({ id: 't2', slot: 1 })
  })

  test('the plain-text fallback carries the tab id for drops outside the app', () => {
    const dt = transfer()
    writeTabDrag(dt, { id: 't2', slot: 1 })

    expect(dt.getData('text/plain')).toBe('t2')
  })

  test('a drag from outside the app is neither recognised nor decoded', () => {
    const dt = transfer({ 'text/plain': '/etc/hosts' })

    expect(isTabDrag(dt)).toBe(false)
    expect(readTabDrag(dt)).toBeNull()
  })

  test('a payload of the right type but the wrong shape decodes to nothing', () => {
    expect(readTabDrag(transfer({ [TAB_DRAG_MIME]: 'not json' }))).toBeNull()
    expect(readTabDrag(transfer({ [TAB_DRAG_MIME]: '{"id":"t1"}' }))).toBeNull()
    expect(readTabDrag(transfer({ [TAB_DRAG_MIME]: '{"id":1,"slot":0}' }))).toBeNull()
  })
})

describe('dropIndexAt', () => {
  test('the left half of a tab inserts before it and the right half after it', () => {
    const spans = strip(3)

    expect(dropIndexAt(spans, 10)).toBe(0)
    expect(dropIndexAt(spans, 49)).toBe(0)
    expect(dropIndexAt(spans, 51)).toBe(1)
    expect(dropIndexAt(spans, 149)).toBe(1)
    expect(dropIndexAt(spans, 151)).toBe(2)
  })

  test('a pointer past the last tab appends, which is what a drop on the empty strip means', () => {
    expect(dropIndexAt(strip(3), 900)).toBe(3)
  })

  test('an empty group takes every drop at its only position', () => {
    expect(dropIndexAt([], 0)).toBe(0)
    expect(dropIndexAt([], 400)).toBe(0)
  })

  test('a strip scrolled away from the viewport origin is read in viewport coordinates', () => {
    const spans = [
      { left: 300, width: 100 },
      { left: 400, width: 100 }
    ]

    expect(dropIndexAt(spans, 320)).toBe(0)
    expect(dropIndexAt(spans, 380)).toBe(1)
    expect(dropIndexAt(spans, 480)).toBe(2)
  })
})

describe('dropTargetIndex', () => {
  test('a tab arriving from another group takes the insert index as it stands', () => {
    expect(dropTargetIndex(['a', 'b', 'c'], 'x', 0)).toBe(0)
    expect(dropTargetIndex(['a', 'b', 'c'], 'x', 2)).toBe(2)
    expect(dropTargetIndex(['a', 'b', 'c'], 'x', 3)).toBe(3)
  })

  test('a tab moving forward inside its own group loses the place it vacated', () => {
    // Dropping "a" after "c" is insert index 3, but with "a" lifted out only three places remain.
    expect(dropTargetIndex(['a', 'b', 'c'], 'a', 3)).toBe(2)
    expect(dropTargetIndex(['a', 'b', 'c'], 'a', 2)).toBe(1)
  })

  test('a tab moving backwards inside its own group keeps the insert index', () => {
    expect(dropTargetIndex(['a', 'b', 'c'], 'c', 0)).toBe(0)
    expect(dropTargetIndex(['a', 'b', 'c'], 'c', 1)).toBe(1)
  })

  test('a drop on either side of the tab itself leaves it where it is', () => {
    expect(dropTargetIndex(['a', 'b', 'c'], 'b', 1)).toBe(1)
    expect(dropTargetIndex(['a', 'b', 'c'], 'b', 2)).toBe(1)
  })

  test('an index past the end clamps to the last place the group has', () => {
    expect(dropTargetIndex(['a', 'b'], 'a', 9)).toBe(1)
    expect(dropTargetIndex(['a', 'b'], 'x', 9)).toBe(2)
  })
})
