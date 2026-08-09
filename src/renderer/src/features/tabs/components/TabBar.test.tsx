import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Tab, WorkItemRef } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { useTabsStore } from '../store'
import { TabBar } from './TabBar'

const WORKSPACE_ID = 'ws1'

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title: id,
    preset: 'shell',
    paneSlot: null,
    sortOrder: 0,
    resumeSessionId: null,
    sessionStatus: null,
    suspendReason: null,
    suspendedAt: null,
    ...over
  }
}

function workItem(tabId: string): WorkItemRef {
  return {
    tabId,
    source: 'jira',
    externalKey: 'FID2507-611',
    projectId: 'p1',
    snapshot: { key: 'FID2507-611', title: 'Repair the importer', type: 'Task' },
    state: 'linked',
    assignedAt: 1
  }
}

/** A hydrated workspace with three tabs, one of them carrying a work item and an attention state. */
function seedTabs(): void {
  useTabsStore.setState({
    status: 'ready',
    error: null,
    workspaceId: WORKSPACE_ID,
    byId: {
      t1: tab('t1', { title: 'shell', paneSlot: 0 }),
      t2: tab('t2', { title: 'claude', preset: 'claude', paneSlot: 1, sortOrder: 1 }),
      t3: tab('t3', { title: 'logs', sortOrder: 2 })
    },
    order: ['t1', 't2', 't3'],
    layout: 'columns',
    activeTabId: 't2',
    presetPickerOpen: false
  })
  useWorkItemsStore.setState({ workspaceId: WORKSPACE_ID, byTabId: { t2: workItem('t2') } })
  useAttentionStore.setState({
    status: { [makeSessionId(WORKSPACE_ID, 't2')]: { status: 'waiting', since: Date.now() } }
  })
}

const tabEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-tab')]
const menuItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-menu__item')]
// An entry renders its icon before its label, so the label is the trailing text node on its own.
const menuLabels = (): (string | null | undefined)[] =>
  menuItems().map((e) => e.lastChild?.textContent)

/** Open the tab-strip overflow list the way the user does. */
function openOverflow(): void {
  fireEvent.click(document.querySelector<HTMLElement>('[aria-label="All tabs"]')!)
}

/**
 * The tab bar, mounted client-side. Static markup cannot expose a re-render loop, so only a real
 * root exercises how the bar subscribes to the tab list.
 */
describe('TabBar', () => {
  afterEach(() => {
    useTabsStore.setState({
      status: 'idle',
      error: null,
      workspaceId: null,
      byId: {},
      order: [],
      layout: 'single',
      activeTabId: null,
      presetPickerOpen: false
    })
    useWorkItemsStore.setState({ workspaceId: null, byTabId: {} })
    useAttentionStore.setState({ status: {} })
  })

  test('mounts and settles without a render loop', async () => {
    seedTabs()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<TabBar />)
      })

      expect(logged).toEqual([])
      const titles = [...document.querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
      expect(titles).toEqual(['shell', 'claude', 'logs'])
      expect(document.querySelectorAll('.ix-tab--active')).toHaveLength(1)
      expect(document.querySelector('.ix-tab__workitem')?.textContent).toBe('FID2507-611')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('reordering the tabs re-renders the subscribed bar', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    await act(async () => {
      useTabsStore.setState({ order: ['t3', 't1', 't2'] })
    })

    const titles = [...document.querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
    expect(titles).toEqual(['logs', 'shell', 'claude'])
  })

  test('the overflow list names every open tab and marks the ones needing attention', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    await act(async () => {
      openOverflow()
    })

    expect(menuLabels()).toEqual(['shell', 'claude', 'logs'])
    // Only the Claude session is waiting, and the list is where a tab scrolled out of the strip
    // can still be seen to be waiting.
    expect(document.querySelectorAll('.ix-tabmenu__dot')).toHaveLength(1)
    expect(menuItems()[1].querySelector('.ix-tabmenu__dot--waiting')).not.toBeNull()
  })

  test('picking a tab from the overflow list activates it', async () => {
    seedTabs()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await act(async () => {
        render(<TabBar />)
      })
      await act(async () => {
        openOverflow()
      })
      await act(async () => {
        fireEvent.click(menuItems()[2])
      })

      expect(setActiveTab).toHaveBeenCalledWith('t3')
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('activating a tab scrolls the strip to it', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    const reveal = vi.fn()
    tabEls()[2].scrollIntoView = reveal
    await act(async () => {
      useTabsStore.setState({ activeTabId: 't3' })
    })

    expect(reveal).toHaveBeenCalled()
  })

  test('picking the tab that is already active still scrolls the strip to it', async () => {
    seedTabs()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await act(async () => {
        render(<TabBar />)
      })
      const reveal = vi.fn()
      tabEls()[1].scrollIntoView = reveal
      await act(async () => {
        openOverflow()
      })
      await act(async () => {
        fireEvent.click(menuItems()[1])
      })

      // Nothing about the active tab changed, so only an unconditional reveal can honour the pick.
      expect(setActiveTab).toHaveBeenCalledWith('t2')
      expect(reveal).toHaveBeenCalled()
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('two tabs sharing a title stay distinguishable in the overflow list', async () => {
    seedTabs()
    useTabsStore.setState({
      byId: {
        t1: tab('t1', { title: 'shell', paneSlot: 0 }),
        t2: tab('t2', { title: 'shell', paneSlot: 1, sortOrder: 1 })
      },
      order: ['t1', 't2']
    })
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      await act(async () => {
        render(<TabBar />)
      })
      await act(async () => {
        openOverflow()
      })
      expect(menuLabels()).toEqual(['shell', 'shell'])
      await act(async () => {
        fireEvent.click(menuItems()[1])
      })

      // The second entry must reach the second tab: two identical labels are only telling apart
      // by position, so a list keyed on the label would hand this click to the wrong tab.
      expect(setActiveTab).toHaveBeenCalledWith('t2')
      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
      setActiveTab.mockRestore()
    }
  })

  test('the overflow button closes the list it opened', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    await act(async () => {
      openOverflow()
    })
    expect(menuItems()).toHaveLength(3)

    // A real press is a mousedown then a click. The menu dismisses itself on any mousedown
    // outside it, so without its button being exempt the click would only ever reopen it.
    const button = document.querySelector<HTMLElement>('[aria-label="All tabs"]')!
    await act(async () => {
      fireEvent.mouseDown(button)
    })
    await act(async () => {
      fireEvent.click(button)
    })

    expect(menuItems()).toHaveLength(0)
  })

  test('a right-click still opens the tab context menu', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    await act(async () => {
      fireEvent.contextMenu(tabEls()[0])
    })

    expect(menuLabels()).toContain('Rename')
    expect(menuLabels()).toContain('Close tab')
  })
})
