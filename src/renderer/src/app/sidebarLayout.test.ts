import { beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayout } from '@common/domain'
import { useSidebarLayoutStore } from './sidebarLayout'

const saved: SidebarLayout[] = []
let stored: SidebarLayout | Error = { ...DEFAULT_SIDEBAR_LAYOUT }

beforeEach(() => {
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
  useSidebarLayoutStore.setState({ ...DEFAULT_SIDEBAR_LAYOUT, touched: false })
})

describe('the sidebar layout store', () => {
  test('hydrate adopts the saved sizes', async () => {
    stored = { width: 300, railHeight: 220, usageHeight: 140 }

    await useSidebarLayoutStore.getState().hydrate()

    expect(useSidebarLayoutStore.getState()).toMatchObject({
      width: 300,
      railHeight: 220,
      usageHeight: 140
    })
  })

  test('a drag that lands while the read is in flight is not undone by it', async () => {
    // The dividers are live from the first paint, so this is reachable: without the guard the
    // stored width lands on top of the user's own, and the next gesture then writes it.
    stored = { width: 300, railHeight: null, usageHeight: null }
    const reading = useSidebarLayoutStore.getState().hydrate()
    useSidebarLayoutStore.getState().setWidth(420)
    await reading

    expect(useSidebarLayoutStore.getState().width).toBe(420)
  })

  test('a failed read still leaves a usable, resizable sidebar', async () => {
    stored = new Error('core is not answering')

    await useSidebarLayoutStore.getState().hydrate()

    expect(useSidebarLayoutStore.getState()).toMatchObject(DEFAULT_SIDEBAR_LAYOUT)
    useSidebarLayoutStore.getState().setWidth(320)
    expect(useSidebarLayoutStore.getState().width).toBe(320)
  })

  test('save before any gesture writes nothing, so it cannot overwrite the saved sizes', async () => {
    stored = { width: 380, railHeight: null, usageHeight: null }
    const reading = useSidebarLayoutStore.getState().hydrate()
    useSidebarLayoutStore.getState().save()
    await reading

    expect(saved).toEqual([])
    expect(useSidebarLayoutStore.getState().width).toBe(380)
  })

  test('a setter changes memory only; save writes every size in one document', () => {
    useSidebarLayoutStore.getState().setWidth(300)
    useSidebarLayoutStore.getState().setRailHeight(200)
    expect(saved).toEqual([])

    useSidebarLayoutStore.getState().save()

    expect(saved).toEqual([{ width: 300, railHeight: 200, usageHeight: null }])
  })

  test('null puts a panel back to sizing itself by its content', () => {
    useSidebarLayoutStore.getState().setRailHeight(200)
    useSidebarLayoutStore.getState().save()
    useSidebarLayoutStore.getState().setRailHeight(null)
    useSidebarLayoutStore.getState().save()

    expect(useSidebarLayoutStore.getState().railHeight).toBeNull()
    expect(saved.at(-1)?.railHeight).toBeNull()
  })
})
