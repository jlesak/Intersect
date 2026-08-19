import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Layout, Tab, WorkItemRef } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { dragEvent, fakeDataTransfer } from '@renderer/shared/dragTestkit'
import { useTabsStore } from '../store'
import { PaneTabBar } from './PaneTabBar'
import { TAB_DRAG_MIME } from './tabDrag'

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

// The label rides on the tab list inside the bar, so the bar itself is that list's own root.
const barOf = (slot: number): HTMLElement =>
  document
    .querySelector<HTMLElement>(`[aria-label="Pane ${slot + 1} tabs"]`)!
    .closest<HTMLElement>('.ix-tabbar')!
const titlesIn = (slot: number): (string | null)[] =>
  [...barOf(slot).querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
const tabElsIn = (slot: number): HTMLElement[] => [
  ...barOf(slot).querySelectorAll<HTMLElement>('.ix-tab')
]
const menuItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-menu__item')]
// An entry renders its icon before its label, so the label is the trailing text node on its own.
const menuLabels = (): (string | null | undefined)[] =>
  menuItems().map((e) => e.lastChild?.textContent)

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
      presetPickerOpen: false,
      dropSlot: null
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

  test('the one bar of a single layout is marked neither focused nor unfocused', async () => {
    seedTabs('single')
    // Everything in one group, which is what collapsing to single leaves behind.
    useTabsStore.setState({
      byId: {
        t1: tab('t1', { title: 'shell', paneSlot: 0, sortOrder: 0 }),
        t2: tab('t2', { title: 'claude', paneSlot: 0, sortOrder: 1 })
      },
      order: ['t1', 't2'],
      activeTabId: 't1'
    })
    await renderStage('single')

    // There is no other bar to tell this one from, so it carries neither marker - and therefore
    // none of the muting the unfocused marker brings with it.
    expect(barOf(0).className).toBe('ix-tabbar')
  })

  test('a bar that is not the focused one is marked as such once there is a second bar', async () => {
    seedTabs()
    await renderStage('columns')

    expect(barOf(0).classList.contains('ix-tabbar--unfocused')).toBe(true)
    expect(barOf(1).classList.contains('ix-tabbar--unfocused')).toBe(false)
  })

  test('every group marks the tab its own pane is showing, focused or not', async () => {
    seedTabs()
    await renderStage('columns')

    // Group 0 is not the focused one and nobody has activated a tab in it, so it shows - and
    // marks - the first tab of its bar.
    expect(tabElsIn(0).map((e) => e.classList.contains('ix-tab--active'))).toEqual([true, false])
    expect(tabElsIn(1).map((e) => e.classList.contains('ix-tab--active'))).toEqual([true])

    // The marker follows that group's own activation history, not the workspace's active tab.
    await act(async () => {
      useTabsStore.setState((s) => ({
        byId: { ...s.byId, t3: { ...s.byId.t3, lastActiveAt: 500 } }
      }))
    })
    expect(tabElsIn(0).map((e) => e.classList.contains('ix-tab--active'))).toEqual([false, true])
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

  test('dragging over a bar names its pane as the one the tab would land in', async () => {
    seedTabs()
    await renderStage('columns')
    measure(1)
    const dataTransfer = fakeDataTransfer()
    const strip = barOf(1).querySelector('.ix-tabs')!

    await act(async () => {
      fireEvent(tabElsIn(0)[0], dragEvent('dragstart', dataTransfer))
    })
    await act(async () => {
      fireEvent(strip, dragEvent('dragover', dataTransfer, 20))
    })
    // The stage draws the mark on the pane; the bar's part is naming which pane that is.
    expect(useTabsStore.getState().dropSlot).toBe(1)

    await act(async () => {
      fireEvent(strip, dragEvent('dragleave', dataTransfer, 20))
    })
    expect(useTabsStore.getState().dropSlot).toBeNull()
  })

  test('dragging a tab from one group onto another moves it to the pointed-at position', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      measure(1)
      const dataTransfer = fakeDataTransfer()

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
      const dataTransfer = fakeDataTransfer()

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
      const dataTransfer = fakeDataTransfer()

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
      const dataTransfer = fakeDataTransfer()
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

  test('a group presents its tabs as a keyboard-reachable tab list', async () => {
    seedTabs()
    await renderStage('columns')

    expect(barOf(0).querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Pane 1 tabs'
    )
    expect(tabElsIn(0).map((e) => e.getAttribute('role'))).toEqual(['tab', 'tab'])
    expect(tabElsIn(0).map((e) => e.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    // Only the tab the pane shows is in the tab order; the arrow keys reach the rest of the bar.
    expect(tabElsIn(0).map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(tabElsIn(0).map((e) => e.getAttribute('aria-posinset'))).toEqual(['1', '2'])
    expect(tabElsIn(0).map((e) => e.getAttribute('aria-setsize'))).toEqual(['2', '2'])
  })

  test('Enter on a focused tab activates it', async () => {
    seedTabs()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.keyDown(tabElsIn(0)[1], { key: 'Enter' })
      })

      expect(setActiveTab).toHaveBeenCalledWith('t3')
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('the arrow keys walk focus along the bar, wrapping at its ends', async () => {
    seedTabs()
    await renderStage('columns')

    await act(async () => {
      tabElsIn(0)[0].focus()
      fireEvent.keyDown(tabElsIn(0)[0], { key: 'ArrowRight' })
    })
    expect(document.activeElement).toBe(tabElsIn(0)[1])

    await act(async () => {
      fireEvent.keyDown(tabElsIn(0)[1], { key: 'ArrowRight' })
    })
    expect(document.activeElement).toBe(tabElsIn(0)[0])
  })

  test('Shift and an arrow move the tab along its bar and say where it went', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.keyDown(tabElsIn(0)[0], { key: 'ArrowRight', shiftKey: true })
      })

      expect(moveTab).toHaveBeenCalledWith('t1', 0, 1)
      expect(barOf(0).querySelector('[role="status"]')?.textContent).toBe(
        'shell moved to position 2 of 2 in pane 1.'
      )
    } finally {
      moveTab.mockRestore()
    }
  })

  test('Shift and an arrow at the end of the bar move nothing and say so', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.keyDown(tabElsIn(0)[0], { key: 'ArrowLeft', shiftKey: true })
      })

      expect(moveTab).not.toHaveBeenCalled()
      expect(barOf(0).querySelector('[role="status"]')?.textContent).toBe(
        'shell is already first in pane 1.'
      )
    } finally {
      moveTab.mockRestore()
    }
  })

  test('a tab being renamed keeps its arrow keys for the text field', async () => {
    seedTabs()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.doubleClick(tabElsIn(0)[0])
      })
      const input = barOf(0).querySelector<HTMLInputElement>('.ix-tab__rename')!

      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowRight', shiftKey: true })
      })

      expect(moveTab).not.toHaveBeenCalled()
      expect(setActiveTab).not.toHaveBeenCalled()
    } finally {
      moveTab.mockRestore()
      setActiveTab.mockRestore()
    }
  })

  test('Enter on a tab’s close button closes it', async () => {
    seedTabs()
    const removeTab = vi.spyOn(useTabsStore.getState(), 'removeTab').mockResolvedValue()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await renderStage('columns')
      await act(async () => {
        fireEvent.keyDown(barOf(0).querySelector('[aria-label="Close shell"]')!, { key: 'Enter' })
      })

      expect(removeTab).toHaveBeenCalledWith('t1')
      // The tab underneath must not take the same key as an activation.
      expect(setActiveTab).not.toHaveBeenCalled()
    } finally {
      removeTab.mockRestore()
      setActiveTab.mockRestore()
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
