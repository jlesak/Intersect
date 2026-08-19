import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tab } from '@common/domain'
import { equalShares } from '@common/terminalLayoutShares'
import { TAB_DRAG_MIME, useTabsStore } from '@renderer/features/tabs'
import { dragEvent, fakeDataTransfer, type FakeDataTransfer } from '@renderer/shared/dragTestkit'
import { useLayoutRatiosStore } from '../layoutRatios'
import * as ipc from '../ipc'
import { SplitStage, type SplitStageProps } from './SplitStage'

// The stage's structure is under test, so the terminal controller and the tab bar both stand in as
// marker divs. The bar has its own suite; here all that matters is that every pane gets one, and
// which group it was told to show.
vi.mock('./TerminalPane', async () => {
  const { createElement } = await import('react')
  return {
    TerminalPane: ({ sessionId }: { sessionId: string }) =>
      createElement('div', { className: 'test-terminal', 'data-session-id': sessionId })
  }
})

vi.mock('@renderer/features/tabs/components/PaneTabBar', async () => {
  const { createElement } = await import('react')
  return {
    PaneTabBar: ({ slot }: { slot: number }) =>
      createElement('div', { className: 'test-tabbar', 'data-slot': String(slot) }),
    openTabInGroup: vi.fn(async () => {})
  }
})

vi.mock('../ipc', () => ({
  getTerminalLayouts: vi.fn(async () => ({})),
  setTerminalLayout: vi.fn(async () => undefined)
}))

const getLayouts = vi.mocked(ipc.getTerminalLayouts)
const setLayout = vi.mocked(ipc.setTerminalLayout)

function tab(id: string, paneSlot: number): Tab {
  return {
    id,
    workspaceId: 'ws1',
    title: id,
    preset: 'shell',
    paneSlot,
    sortOrder: 0,
    lastActiveAt: null,
    resumeSessionId: null,
    sessionStatus: null,
    suspendReason: null,
    suspendedAt: null
  }
}

/** The stage reads which tab each group shows straight off the tabs store, so tests seed it. */
function seedTabs(tabs: Tab[]): void {
  useTabsStore.setState({
    status: 'ready',
    workspaceId: 'ws1',
    byId: Object.fromEntries(tabs.map((t) => [t.id, t])),
    order: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null
  })
}

function stage(props: Partial<SplitStageProps> = {}): React.ReactElement {
  return React.createElement(SplitStage, {
    workspaceId: 'ws1',
    cwd: '/repo',
    projectKey: 'p1',
    layout: 'columns',
    ...props
  })
}

function seedLoaded(): void {
  useLayoutRatiosStore.setState({
    projectKey: 'p1',
    loaded: true,
    columns: [70, 30],
    rows: [60, 40],
    grid: equalShares('grid')
  })
}

const initial = useLayoutRatiosStore.getState()

// The stage reads its shares through the store hook, so it must be client-rendered (static
// markup would only ever see the store's initial pre-hydration snapshot). jsdom neither
// implements ResizeObserver nor lays elements out; the panel library needs both to arm
// itself, so give it a no-op observer and a fixed measured size.
let host: HTMLDivElement
let root: Root
const offsetDescriptors = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 500 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 500 })
  useLayoutRatiosStore.setState(initial, true)
  seedTabs([tab('t1', 0), tab('t2', 1)])
  getLayouts.mockClear()
  getLayouts.mockResolvedValue({})
  setLayout.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useTabsStore.getState().clear()
  if (offsetDescriptors.width) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetDescriptors.width)
  }
  if (offsetDescriptors.height) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetDescriptors.height)
  }
  vi.unstubAllGlobals()
})

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
  })
}

/** The area under one pane's tab bar: its terminal, or its empty state, and its drop surface. */
const paneBody = (index: number): HTMLElement =>
  host.querySelectorAll<HTMLElement>('.ix-pane__body')[index]

describe('SplitStage structure', () => {
  test('single renders one plain pane and no resize handles', async () => {
    seedLoaded()
    await render(stage({ layout: 'single' }))
    expect(host.querySelectorAll('.ix-pane')).toHaveLength(1)
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(0)
    expect(host.querySelector('.ix-stage--single')).toBeTruthy()
  })

  test('columns renders two panels split by one visible keyboard-focusable handle', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns' }))
    expect(host.querySelector('.ix-stage--columns.ix-stage--resizable')).toBeTruthy()
    expect(host.querySelectorAll('[data-panel]')).toHaveLength(2)
    expect(host.querySelectorAll('.ix-pane')).toHaveLength(2)
    const sep = host.querySelector('[role="separator"]')
    expect(sep?.classList.contains('ix-stage__sep')).toBe(true)
    expect(sep?.getAttribute('tabindex')).toBe('0')
    // A separator between columns is a vertical divider dragged left/right.
    expect(sep?.getAttribute('aria-orientation')).toBe('vertical')
  })

  test('rows renders a vertical group whose handle is a horizontal divider', async () => {
    seedLoaded()
    await render(stage({ layout: 'rows' }))
    expect(host.querySelector('.ix-stage--rows.ix-stage--resizable')).toBeTruthy()
    const sep = host.querySelector('[role="separator"]')
    expect(sep?.getAttribute('aria-orientation')).toBe('horizontal')
  })

  test('grid nests a row group per column half, slots keeping their positions', async () => {
    seedLoaded()
    seedTabs([tab('t1', 0), tab('t2', 1), tab('t3', 2), tab('t4', 3)])
    await render(stage({ layout: 'grid' }))
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(3)
    // Left half holds slots 0 and 2 (top/bottom), right half slots 1 and 3.
    const left = host.querySelector('[data-panel][id="left"]')
    const right = host.querySelector('[data-panel][id="right"]')
    expect(left?.querySelector('[id="slot-0"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t1')
    expect(left?.querySelector('[id="slot-2"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t3')
    expect(right?.querySelector('[id="slot-1"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t2')
    expect(right?.querySelector('[id="slot-3"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t4')
  })

  test('every pane carries its own tab bar, above the terminal it names', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns' }))
    const bars = [...host.querySelectorAll('.test-tabbar')]
    expect(bars.map((b) => b.getAttribute('data-slot'))).toEqual(['0', '1'])
    // The bar comes first inside the pane, so the tab name sits directly over its terminal.
    const pane = host.querySelector('[id="slot-0"] .ix-pane')!
    expect([...pane.children].map((c) => c.className)).toEqual(['test-tabbar', 'ix-pane__body'])
    expect(pane.querySelector('.ix-pane__body .test-terminal')).toBeTruthy()
  })

  test('a group with no tabs keeps its bar and offers the two terminal starters', async () => {
    seedLoaded()
    seedTabs([tab('t1', 0)])
    await render(stage({ layout: 'columns' }))
    const empty = host.querySelector('.ix-pane__empty')?.closest('.ix-pane')
    expect(empty).toBeTruthy()
    expect(empty?.querySelector('.test-tabbar')).toBeTruthy()
    expect(empty?.querySelector('.test-terminal')).toBeNull()
    const starters = [...empty!.querySelectorAll('.ix-pane__empty .ix-btn')].map((b) => b.textContent)
    expect(starters.map((t) => t?.trim())).toEqual(['Shell', 'Claude Code'])
  })

  test('a group shows the tab it activated most recently', async () => {
    seedLoaded()
    seedTabs([
      tab('t1', 0),
      { ...tab('t2', 0), sortOrder: 1, lastActiveAt: 500 },
      tab('t3', 1)
    ])
    await render(stage({ layout: 'columns' }))
    expect(
      host.querySelector('[id="slot-0"] .test-terminal')?.getAttribute('data-session-id')
    ).toBe('ws1:t2')
  })

  test('before the project shares load, the stage falls back to the static equal grid', async () => {
    getLayouts.mockImplementation(() => new Promise(() => {}))
    await render(stage({ layout: 'columns' }))
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(0)
    expect(host.querySelector('.ix-stage--resizable')).toBeNull()
    expect(host.querySelectorAll('.ix-pane')).toHaveLength(2)
  })

  test('mounting the stage loads the project shares and then renders the resizable split', async () => {
    getLayouts.mockResolvedValue({ columns: [70, 30] })
    await render(stage({ layout: 'columns' }))
    expect(getLayouts).toHaveBeenCalledWith('p1')
    expect(host.querySelector('.ix-stage--resizable')).toBeTruthy()
    expect(useLayoutRatiosStore.getState().columns).toEqual([70, 30])
  })
})

describe('SplitStage focus', () => {
  test('pressing inside a pane hands focus to the group that pane holds', async () => {
    seedLoaded()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))
      await act(async () => {
        paneBody(1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })

      expect(setActiveTab).toHaveBeenCalledWith('t2')
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('typing inside a pane hands focus to the group that pane holds', async () => {
    seedLoaded()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))
      await act(async () => {
        paneBody(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      })

      expect(setActiveTab).toHaveBeenCalledWith('t2')
    } finally {
      setActiveTab.mockRestore()
    }
  })

  test('working in the pane that already has focus asks for nothing', async () => {
    seedLoaded()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))
      await act(async () => {
        paneBody(0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        paneBody(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      })

      expect(setActiveTab).not.toHaveBeenCalled()
    } finally {
      setActiveTab.mockRestore()
    }
  })
})

describe('SplitStage as a drop target', () => {
  /** A transfer carrying a tab drag, the way a tab's own dragstart handler writes one. */
  function tabDrag(id: string, slot: number): FakeDataTransfer {
    const transfer = fakeDataTransfer()
    transfer.setData(TAB_DRAG_MIME, JSON.stringify({ id, slot }))
    return transfer
  }

  test('a tab dragged over a pane body marks that pane as the one it would land in', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns' }))
    const transfer = tabDrag('t1', 0)

    await act(async () => {
      paneBody(1).dispatchEvent(dragEvent('dragover', transfer))
    })

    const marked = [...host.querySelectorAll('.ix-pane')].map((p) =>
      p.classList.contains('ix-pane--drop')
    )
    expect(marked).toEqual([false, true])
    // Without this the drag keeps the no-drop cursor and the release does nothing at all.
    expect(transfer.dropEffect).toBe('move')
  })

  test('leaving the pane again drops the mark', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns' }))
    const transfer = tabDrag('t1', 0)

    await act(async () => {
      paneBody(1).dispatchEvent(dragEvent('dragover', transfer))
    })
    await act(async () => {
      paneBody(1).dispatchEvent(dragEvent('dragleave', transfer))
    })

    expect(host.querySelector('.ix-pane--drop')).toBeNull()
  })

  test('dropping a tab on a pane body moves it to the end of that pane’s group', async () => {
    seedLoaded()
    seedTabs([tab('t1', 0), tab('t2', 1), { ...tab('t3', 0), sortOrder: 1 }])
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))

      await act(async () => {
        paneBody(1).dispatchEvent(dragEvent('drop', tabDrag('t3', 0)))
      })

      // Group 1 already holds one tab, so the end of it is index 1.
      expect(moveTab).toHaveBeenCalledWith('t3', 1, 1)
      expect(host.querySelector('.ix-pane--drop')).toBeNull()
    } finally {
      moveTab.mockRestore()
    }
  })

  test('dropping a tab on the pane its own group already fills just shows it', async () => {
    seedLoaded()
    seedTabs([tab('t1', 0), tab('t2', 1), { ...tab('t3', 0), sortOrder: 1 }])
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    const setActiveTab = vi.spyOn(useTabsStore.getState(), 'setActiveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))

      await act(async () => {
        paneBody(0).dispatchEvent(dragEvent('drop', tabDrag('t3', 0)))
      })

      expect(moveTab).not.toHaveBeenCalled()
      expect(setActiveTab).toHaveBeenCalledWith('t3')
    } finally {
      moveTab.mockRestore()
      setActiveTab.mockRestore()
    }
  })

  test('a drag that is not one of our tabs is refused by the pane', async () => {
    seedLoaded()
    const moveTab = vi.spyOn(useTabsStore.getState(), 'moveTab').mockResolvedValue()
    try {
      await render(stage({ layout: 'columns' }))
      const transfer = fakeDataTransfer()
      transfer.setData('text/plain', '/etc/hosts')

      await act(async () => {
        paneBody(1).dispatchEvent(dragEvent('dragover', transfer))
      })
      expect(host.querySelector('.ix-pane--drop')).toBeNull()

      await act(async () => {
        paneBody(1).dispatchEvent(dragEvent('drop', transfer))
      })
      expect(moveTab).not.toHaveBeenCalled()
    } finally {
      moveTab.mockRestore()
    }
  })
})

describe('SplitStage keyboard resizing', () => {
  test('arrow keys on a focused handle resize the split and persist the new shares', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns' }))

    const sep = host.querySelector<HTMLElement>('[role="separator"]')
    expect(sep).toBeTruthy()
    await act(async () => {
      sep?.focus()
      sep?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    // One 5% keyboard step from the persisted 70/30, committed and flushed immediately.
    expect(useLayoutRatiosStore.getState().columns).toEqual([75, 25])
    expect(setLayout).toHaveBeenCalledWith('p1', 'columns', [75, 25])

    await act(async () => {
      sep?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(useLayoutRatiosStore.getState().columns).toEqual([70, 30])
  })

  test('keyboard resizing never pushes a pane below the 10% minimum', async () => {
    seedLoaded()
    useLayoutRatiosStore.setState({ columns: [88, 12] })
    await render(stage({ layout: 'columns' }))

    const sep = host.querySelector<HTMLElement>('[role="separator"]')
    await act(async () => {
      sep?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(useLayoutRatiosStore.getState().columns).toEqual([90, 10])
  })
})
