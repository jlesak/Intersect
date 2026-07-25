import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Tab, Workspace } from '@common/domain'
import { useAttentionStore } from '@renderer/features/attention'
import { useTabsStore } from '@renderer/features/tabs'
import { useWorkspacesStore } from '../store'
import { WorkspaceView } from './WorkspaceView'

// The split stage owns live xterm instances inside a measured resizable layout, and jsdom provides
// neither layout nor a preload bridge to drive them. The stage has its own suite; here a marker
// stands in for it, and the terminal slice's remaining entry points are inert, so what this mount
// exercises is the terminal area's own subscription to the tab list.
vi.mock('@renderer/features/terminal', () => ({
  SplitStage: ({ tabs }: { tabs: Tab[] }) => (
    <div data-testid="split-stage" data-tab-count={tabs.length} />
  ),
  disposeSession: () => {},
  disposeWorkspaceSessions: () => {}
}))

const WORKSPACE_ID = 'ws1'

const workspace: Workspace = {
  id: WORKSPACE_ID,
  name: 'SPOT',
  folderPath: '/repos/spot',
  layout: 'columns',
  activeTabId: 't2',
  sortOrder: 0,
  projectId: 'p1',
  projectSource: 'manual'
}

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

const TABS = [
  tab('t1', { title: 'shell', paneSlot: 0 }),
  tab('t2', { title: 'claude', preset: 'claude', paneSlot: 1, sortOrder: 1 })
]

/** The bridge calls the view's hydrate effect makes, so a client render reaches a populated state. */
function stubBridge(tabs: Tab[] = TABS): void {
  ;(window as { intersect?: unknown }).intersect = {
    workspaces: {
      getState: () =>
        Promise.resolve({ workspaces: [workspace], selectedWorkspaceId: WORKSPACE_ID })
    },
    tabs: { listByWorkspace: () => Promise.resolve(tabs) }
  }
}

/**
 * The terminal area of a workspace, mounted client-side. Static markup cannot expose a re-render
 * loop, so only a real root exercises how the area subscribes to the tab list.
 */
describe('WorkspaceView', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    useWorkspacesStore.setState({
      status: 'idle',
      error: null,
      byId: {},
      order: [],
      selectedWorkspaceId: null
    })
    useTabsStore.getState().clear()
    useAttentionStore.setState({ status: {} })
  })

  /** A ready workspaces slice with the workspace under test selected. */
  function seedSelection(): void {
    useWorkspacesStore.setState({
      status: 'ready',
      error: null,
      byId: { [WORKSPACE_ID]: workspace },
      order: [WORKSPACE_ID],
      selectedWorkspaceId: WORKSPACE_ID
    })
  }

  test('mounts and settles without a render loop', async () => {
    stubBridge()
    seedSelection()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<WorkspaceView projectScope="p1" />)
      })

      expect(logged).toEqual([])
      // Hydration filled the tab list, so both the bar and the stage read a populated selector.
      const titles = [...document.querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
      expect(titles).toEqual(['shell', 'claude'])
      const stage = document.querySelector('[data-testid="split-stage"]')
      expect(stage?.getAttribute('data-tab-count')).toBe('2')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a hydrated workspace with no tabs offers the terminal starters', async () => {
    stubBridge([])
    seedSelection()

    await act(async () => {
      render(<WorkspaceView projectScope="p1" />)
    })

    expect(document.querySelector('[data-testid="split-stage"]')).toBeNull()
    expect(document.querySelector('.ix-empty__title')?.textContent).toBe(
      'Open a terminal to get going'
    )
  })
})
