import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type SidebarLayout
} from '@common/domain'
import { SAVE_DELAY_MS, useSidebarLayoutStore } from './sidebarLayout'

const saved: SidebarLayout[] = []
let stored: SidebarLayout | Error = { ...DEFAULT_SIDEBAR_LAYOUT }

beforeEach(() => {
  vi.useFakeTimers()
  saved.length = 0
  stored = { ...DEFAULT_SIDEBAR_LAYOUT }
  ;(window as unknown as { intersect: unknown }).intersect = {
    system: {
      getSidebarLayout: () => (stored instanceof Error ? Promise.reject(stored) : Promise.resolve(stored)),
      setSidebarLayout: (layout: SidebarLayout) => {
        saved.push(layout)
        return Promise.resolve(layout)
      }
    }
  }
  useSidebarLayoutStore.setState({ ...DEFAULT_SIDEBAR_LAYOUT, loaded: false })
})

/** Let the debounced write fire. */
const settle = (): void => {
  vi.advanceTimersByTime(SAVE_DELAY_MS + 1)
}

describe('the sidebar layout store', () => {
  test('hydrate adopts the saved sizes', async () => {
    stored = { width: 300, railHeight: 220, usageHeight: 140 }

    await useSidebarLayoutStore.getState().hydrate()

    expect(useSidebarLayoutStore.getState()).toMatchObject({
      width: 300,
      railHeight: 220,
      usageHeight: 140,
      loaded: true
    })
  })

  test('a failed read still leaves a usable, resizable sidebar', async () => {
    stored = new Error('core is not answering')

    await useSidebarLayoutStore.getState().hydrate()

    expect(useSidebarLayoutStore.getState()).toMatchObject({ ...DEFAULT_SIDEBAR_LAYOUT, loaded: true })
    useSidebarLayoutStore.getState().setWidth(320)
    expect(useSidebarLayoutStore.getState().width).toBe(320)
  })

  test('the width is held inside its bounds', () => {
    useSidebarLayoutStore.getState().setWidth(10_000)
    expect(useSidebarLayoutStore.getState().width).toBe(SIDEBAR_WIDTH_MAX)

    useSidebarLayoutStore.getState().setWidth(0)
    expect(useSidebarLayoutStore.getState().width).toBe(SIDEBAR_WIDTH_MIN)
  })

  test('a panel can never be dragged smaller than its floor', () => {
    useSidebarLayoutStore.getState().setRailHeight(2)
    useSidebarLayoutStore.getState().setUsageHeight(-40)

    expect(useSidebarLayoutStore.getState().railHeight).toBeGreaterThanOrEqual(64)
    expect(useSidebarLayoutStore.getState().usageHeight).toBeGreaterThanOrEqual(64)
  })

  test('a drag applies at once but is written once it settles', () => {
    useSidebarLayoutStore.getState().setWidth(300)
    useSidebarLayoutStore.getState().setWidth(310)
    useSidebarLayoutStore.getState().setWidth(320)

    expect(useSidebarLayoutStore.getState().width).toBe(320)
    expect(saved).toEqual([])

    settle()
    expect(saved).toEqual([{ width: 320, railHeight: null, usageHeight: null }])
  })

  test('one panel is written with the sizes of the others, never on its own', () => {
    useSidebarLayoutStore.getState().setWidth(300)
    settle()
    useSidebarLayoutStore.getState().setRailHeight(200)
    settle()

    expect(saved.at(-1)).toEqual({ width: 300, railHeight: 200, usageHeight: null })
  })

  test('null puts a panel back to sizing itself by its content', () => {
    useSidebarLayoutStore.getState().setRailHeight(200)
    settle()
    useSidebarLayoutStore.getState().setRailHeight(null)
    settle()

    expect(useSidebarLayoutStore.getState().railHeight).toBeNull()
    expect(saved.at(-1)?.railHeight).toBeNull()
  })

  test('flush writes a drag the window is about to lose', () => {
    useSidebarLayoutStore.getState().setWidth(360)
    expect(saved).toEqual([])

    useSidebarLayoutStore.getState().flush()

    expect(saved).toEqual([{ width: 360, railHeight: null, usageHeight: null }])
  })
})
