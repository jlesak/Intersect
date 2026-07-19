import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tab } from '@common/domain'
import { equalShares } from '@common/terminalLayoutShares'
import { useLayoutRatiosStore } from '../layoutRatios'
import * as ipc from '../ipc'
import { SplitStage, type SplitStageProps } from './SplitStage'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide its classic JSX
// runtime explicitly for the imported production component.
vi.stubGlobal('React', React)

// The stage's structure is under test, not the terminal controller; a marker div stands in
// for the live xterm host.
vi.mock('./TerminalPane', async () => {
  const { createElement } = await import('react')
  return {
    TerminalPane: ({ sessionId }: { sessionId: string }) =>
      createElement('div', { className: 'test-terminal', 'data-session-id': sessionId })
  }
})

vi.mock('../ipc', () => ({
  getTerminalLayouts: vi.fn(async () => ({})),
  setTerminalLayout: vi.fn(async () => undefined)
}))

const getLayouts = vi.mocked(ipc.getTerminalLayouts)
const setLayout = vi.mocked(ipc.setTerminalLayout)

function tab(id: string, paneSlot: number | null): Tab {
  return {
    id,
    workspaceId: 'ws1',
    title: id,
    preset: 'shell',
    paneSlot,
    sortOrder: 0,
    resumeSessionId: null,
    sessionStatus: null,
    suspendReason: null,
    suspendedAt: null
  }
}

function stage(props: Partial<SplitStageProps> = {}): React.ReactElement {
  return React.createElement(SplitStage, {
    workspaceId: 'ws1',
    cwd: '/repo',
    projectKey: 'p1',
    layout: 'columns',
    activeTabId: 't1',
    tabs: [tab('t1', 0), tab('t2', 1)],
    onAssign: () => {},
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
  if (offsetDescriptors.width) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetDescriptors.width)
  }
  if (offsetDescriptors.height) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetDescriptors.height)
  }
  vi.unstubAllGlobals()
  vi.stubGlobal('React', React)
})

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
  })
}

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
    const tabs = [tab('t1', 0), tab('t2', 1), tab('t3', 2), tab('t4', 3)]
    await render(stage({ layout: 'grid', tabs }))
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(3)
    // Left half holds slots 0 and 2 (top/bottom), right half slots 1 and 3.
    const left = host.querySelector('[data-panel][id="left"]')
    const right = host.querySelector('[data-panel][id="right"]')
    expect(left?.querySelector('[id="slot-0"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t1')
    expect(left?.querySelector('[id="slot-2"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t3')
    expect(right?.querySelector('[id="slot-1"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t2')
    expect(right?.querySelector('[id="slot-3"] .test-terminal')?.getAttribute('data-session-id')).toBe('ws1:t4')
  })

  test('an unfilled slot renders the empty-pane placement UI inside its panel', async () => {
    seedLoaded()
    await render(stage({ layout: 'columns', tabs: [tab('t1', 0), tab('t2', null)] }))
    const empty = host.querySelector('.ix-pane--empty')
    expect(empty).toBeTruthy()
    expect(empty?.textContent).toContain('Place “t2” here')
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
