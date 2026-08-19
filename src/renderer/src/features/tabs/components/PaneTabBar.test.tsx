import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Layout, Tab, WorkItemRef } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { useTabsStore } from '../store'
import { PaneTabBar } from './PaneTabBar'
import { TAB_DRAG_MIME, type TabTransfer } from './tabDrag'

const WORKSPACE_ID = 'ws1'

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title: id,
    preset: 'shell',
    paneSlot: 0,
    sortOrder: 0,
    lastActiveAt: null,
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

/**
 * A hydrated workspace split into two groups: two tabs in group 0, one in group 1, which is the
 * one carrying a work item, an attention state, and the focus.
 */
function seedTabs(layout: Layout = 'columns'): void {
  useTabsStore.setState({
    status: 'ready',
    error: null,
    workspaceId: WORKSPACE_ID,
    byId: {
      t1: tab('t1', { title: 'shell', paneSlot: 0, sortOrder: 0 }),
      t2: tab('t2', { title: 'claude', preset: 'claude', paneSlot: 1, sortOrder: 0 }),
      t3: tab('t3', { title: 'logs', paneSlot: 0, sortOrder: 1 })
    },
    order: ['t1', 't3', 't2'],
    layout,
    activeTabId: 't2',
    presetPickerOpen: false
  })
  useWorkItemsStore.setState({ workspaceId: WORKSPACE_ID, byTabId: { t2: workItem('t2') } })
  useAttentionStore.setState({
    status: { [makeSessionId(WORKSPACE_ID, 't2')]: { status: 'waiting', since: Date.now() } }
  })
}

/** Every group's bar, the way the split stage puts them on screen. */
async function renderStage(layout: Layout): Promise<void> {
  await act(async () => {
    render(
      <>
        {Array.from({ length: slotCount(layout) }, (_, slot) => (
          <PaneTabBar key={slot} slot={slot} />
        ))}
      </>
    )
  })
}

const barOf = (slot: number): HTMLElement =>
  document.querySelector<HTMLElement>(`[aria-label="Pane ${slot + 1} tabs"]`)!
const titlesIn = (slot: number): (string | null)[] =>
  [...barOf(slot).querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
const tabElsIn = (slot: number): HTMLElement[] => [
  ...barOf(slot).querySelectorAll<HTMLElement>('.ix-tab')
]
const menuItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-menu__item')]
// An entry renders its icon before its label, so the label is the trailing text node on its own.
const menuLabels = (): (string | null | undefined)[] =>
  menuItems().map((e) => e.lastChild?.textContent)

/** A DataTransfer stand-in, because jsdom provides none for a synthesised drag. */
function transfer(): TabTransfer & { effectAllowed: string; dropEffect: string } {
  const data: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    get types() {
      return Object.keys(data)
    },
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => {
      data[type] = value
    }
  }
}

/**
 * A drag event carrying both a pointer position and a transfer. jsdom implements no DragEvent, so
 * fireEvent's would arrive as a bare Event with no clientX on it at all - and clientX is the whole
 * input to the drop-position arithmetic under test.
 */
function dragEvent(type: string, dataTransfer: TabTransfer, clientX = 0): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

/** Lay the strip's tabs out end to end, since jsdom measures every element as zero-sized. */
function measure(slot: number, width = 100): void {
  tabElsIn(slot).forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * width, width, right: (i + 1) * width }) as DOMRect
  })
}

describe('PaneTabBar', () => {
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

  test('a bar shows its own group and nothing from any other', async () => {
    seedTabs()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await renderStage('columns')

      expect(logged).toEqual([])
      expect(titlesIn(0)).toEqual(['shell', 'logs'])
      expect(titlesIn(1)).toEqual(['claude'])
      // The work item and the attention state belong to the tab, so they travel with it.
      expect(barOf(1).querySelector('.ix-tab__workitem')?.textContent).toBe('FID2507-611')
      expect(barOf(1).querySelector('.ix-tab--waiting')).not.toBeNull()
      expect(barOf(0).querySelector('.ix-tab--waiting')).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('only the group holding the active tab is marked as focused', async () => {
    seedTabs()
    await renderStage('columns')

    expect(barOf(0).classList.contains('ix-tabbar--focused')).toBe(false)
    expect(barOf(1).classList.contains('ix-tabbar--focused')).toBe(true)

    await act(async () => {
      useTabsStore.setState({ activeTabId: 't3' })
    })

    expect(barOf(0).classList.contains('ix-tabbar--focused')).toBe(true)
    expect(barOf(1).classList.contains('ix-tabbar--focused')).toBe(false)
  })

  test('a group with no tabs still shows its bar, carrying only the new-terminal button', async () => {
    seedTabs('columns')
    useTabsStore.setState({
      byId: { t1: tab('t1', { title: 'shell', paneSlot: 0 }) },
      order: ['t1'],
      activeTabId: 't1'
    })
    await renderStage('columns')

    expect(tabElsIn(1)).toHaveLength(0)
    expect(barOf(1).querySelector('[aria-label="New terminal"]')).not.toBeNull()
  })

  test.each([
    ['single', 0],
    ['columns', 1],
    ['rows', 0],
    ['grid', 1]
  ] as const)('in %s the workspace tools sit in exactly one bar, the top-right one', async (
    layout,
    expected
  ) => {
    seedTabs(layout)
    await renderStage(layout)

    const tools = [...document.querySelectorAll('.ix-tabbar__tools')]
    expect(tools).toHaveLength(1)
    expect(barOf(expected).querySelector('.ix-tabbar__tools')).not.toBeNull()
    expect(document.querySelectorAll('[aria-label="All tabs"]')).toHaveLength(1)
    expect(document.querySelectorAll('[aria-label="Split layout"]')).toHaveLength(1)
  })

  test('the overflow list names every tab of the workspace, whichever group holds it', async () => {
    seedTabs()
    await renderStage('columns')
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('[aria-label="All tabs"]')!)
    })

    // Group order, then bar order inside each group - the same order the strips read in.
    expect(menuLabels()).toEqual(['shell', 'logs', 'claude'])
    expect(document.querySelectorAll('.ix-tabmenu__dot--waiting')).toHaveLength(1)
  })

  test('a right-click offers the other panes as move targets, never the tab’s own', async () => {
    seedTabs()
    await renderStage('columns')
    await act(async () => {
      fireEvent.contextMenu(tabElsIn(0)[0])
    })

    expect(menuLabels()).toContain('Rename')
    expect(menuLabels()).toContain('Close tab')
    const openInPane2 = menuItems().find((e) => e.lastChild?.textContent === 'Open in pane 2')
    expect(openInPane2).toBeDefined()
    const openInPane1 = menuItems().find((e) => e.lastChild?.textContent === 'Open in pane 1')
    expect(openInPane1?.hasAttribute('disabled')).toBe(true)
  })

  test('"Open in pane 2" appends the tab to that group', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.contextMenu(tabElsIn(0)[0])
      })
      await act(async () => {
        fireEvent.click(menuItems().find((e) => e.lastChild?.textContent === 'Open in pane 2')!)
      })

      // Group 1 already holds one tab, so appending is index 1.
      expect(moveTab).toHaveBeenCalledWith('t1', 1, 1)
    } finally {
      moveTab.mockRestore()
    }
  })

  test('"Move right" reorders inside the group without leaving it', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.contextMenu(tabElsIn(0)[0])
      })
      await act(async () => {
        fireEvent.click(menuItems().find((e) => e.lastChild?.textContent === 'Move right')!)
      })

      expect(moveTab).toHaveBeenCalledWith('t1', 0, 1)
    } finally {
      moveTab.mockRestore()
    }
  })

  test('dragging a tab from one group onto another moves it to the pointed-at position', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      measure(1)
      const dataTransfer = transfer()

      await act(async () => {
        fireEvent(tabElsIn(0)[0], dragEvent('dragstart', dataTransfer))
      })
      // Group 1's only tab spans 0..100, so a pointer at 20 aims at the gap before it.
      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('dragover', dataTransfer, 20))
      })
      expect(barOf(1).querySelector('.ix-tabs__drop')).not.toBeNull()

      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('drop', dataTransfer, 20))
      })

      expect(moveTab).toHaveBeenCalledWith('t1', 1, 0)
      expect(barOf(1).querySelector('.ix-tabs__drop')).toBeNull()
    } finally {
      moveTab.mockRestore()
    }
  })

  test('a drop past the last tab of the target group appends to it', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      measure(1)
      const dataTransfer = transfer()

      await act(async () => {
        fireEvent(tabElsIn(0)[0], dragEvent('dragstart', dataTransfer))
      })
      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('dragover', dataTransfer, 400))
      })
      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('drop', dataTransfer, 400))
      })

      expect(moveTab).toHaveBeenCalledWith('t1', 1, 1)
    } finally {
      moveTab.mockRestore()
    }
  })

  test('dropping a tab back where it already sits changes nothing', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      measure(0)
      const dataTransfer = transfer()

      await act(async () => {
        fireEvent(tabElsIn(0)[0], dragEvent('dragstart', dataTransfer))
      })
      // Aiming just past t1's midpoint is the gap between t1 and t3, which is where t1 is.
      await act(async () => {
        fireEvent(barOf(0).querySelector('.ix-tabs')!, dragEvent('dragover', dataTransfer, 60))
      })
      await act(async () => {
        fireEvent(barOf(0).querySelector('.ix-tabs')!, dragEvent('drop', dataTransfer, 60))
      })

      expect(moveTab).not.toHaveBeenCalled()
    } finally {
      moveTab.mockRestore()
    }
  })

  test('a drag that is not one of our tabs is refused by the strip', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      const dataTransfer = transfer()
      dataTransfer.setData('text/plain', '/etc/hosts')

      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('dragover', dataTransfer, 20))
      })
      expect(barOf(1).querySelector('.ix-tabs__drop')).toBeNull()

      await act(async () => {
        fireEvent(barOf(1).querySelector('.ix-tabs')!, dragEvent('drop', dataTransfer, 20))
      })
      expect(moveTab).not.toHaveBeenCalled()
      expect(dataTransfer.types).not.toContain(TAB_DRAG_MIME)
    } finally {
      moveTab.mockRestore()
    }
  })

  test('clicking a tab activates it', async () => {
    seedTabs()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.mouseDown(tabElsIn(0)[1])
      })

      expect(setActiveTab).toHaveBeenCalledWith('t3')
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('the new-terminal popover opens in the bar whose "+" was pressed', async () => {
    seedTabs()
    await renderStage('columns')
    const plus = [...document.querySelectorAll<HTMLElement>('[aria-label="New terminal"]')]
    await act(async () => {
      fireEvent.click(plus[0])
    })

    // One popover, raised by group 0's button even though group 1 is the focused one.
    expect(document.querySelectorAll('.ix-presets')).toHaveLength(1)
  })

  test('the keyboard-raised popover appears only in the focused group', async () => {
    seedTabs()
    await renderStage('columns')
    await act(async () => {
      useTabsStore.setState({ presetPickerOpen: true })
    })

    expect(document.querySelectorAll('.ix-presets')).toHaveLength(1)
  })
})
