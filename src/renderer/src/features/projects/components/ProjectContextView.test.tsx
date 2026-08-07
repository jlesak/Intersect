import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Project, Tab, Workspace } from '@common/domain'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { useProjectContextStore } from '../contextStore'
import { useProjectsStore } from '../store'
import { ProjectContextView } from './ProjectContextView'

// The split stage owns live xterm instances inside a measured resizable layout, and jsdom provides
// neither layout nor a preload bridge to drive them. The stage has its own suite; here a marker
// stands in for it, and the terminal slice's remaining entry points are inert, so what this mount
// exercises is the context view's own subscription to the project's workspaces.
vi.mock('@renderer/features/terminal', () => ({
  SplitStage: ({ tabs }: { tabs: Tab[] }) => (
    <div data-testid="split-stage" data-tab-count={tabs.length} />
  ),
  disposeSession: () => {},
  disposeWorkspaceSessions: () => {}
}))

function workspace(id: string, projectId: string | null, sortOrder: number): Workspace {
  return {
    id,
    name: id,
    folderPath: `/repos/${id}`,
    layout: 'single',
    activeTabId: null,
    sortOrder,
    projectId,
    projectSource: 'auto'
  }
}

const WORKSPACES = [
  workspace('spot-api', 'p1', 0),
  workspace('spot-web', 'p1', 1),
  workspace('atlas', 'p2', 2),
  workspace('scratch', null, 3)
]

const PROJECT: Project = {
  id: 'p1',
  name: 'SPOT',
  sortOrder: 0,
  archived: false,
  repoPaths: ['/repos/spot-api', '/repos/spot-web'],
  jiraJql: 'project = FID2507',
  jiraBoardUrl: null,
  adoRepositories: ['spot-backend']
}

const TAB: Tab = {
  id: 't1',
  workspaceId: 'spot-api',
  title: 'shell',
  preset: 'shell',
  paneSlot: 0,
  sortOrder: 0,
  resumeSessionId: null,
  sessionStatus: null,
  suspendReason: null,
  suspendedAt: null
}

/** The bridge calls the context's restore effect and the terminal area's hydrate effect make. */
function stubBridge(): void {
  ;(window as { intersect?: unknown }).intersect = {
    workspaces: {
      getState: () => Promise.resolve({ workspaces: WORKSPACES, selectedWorkspaceId: null }),
      setActive: () => Promise.resolve()
    },
    tabs: { listByWorkspace: (id: string) => Promise.resolve(id === 'spot-api' ? [TAB] : []) }
  }
}

/** Projects and workspaces both loaded, with two of the workspaces bound to the open project. */
function seedContext(): void {
  useProjectsStore.setState({
    status: 'ready',
    error: null,
    overrides: [],
    projects: [PROJECT, { ...PROJECT, id: 'p2', name: 'Atlas', sortOrder: 1 }]
  })
  useWorkspacesStore.setState({
    status: 'ready',
    error: null,
    byId: Object.fromEntries(WORKSPACES.map((w) => [w.id, w])),
    order: WORKSPACES.map((w) => w.id),
    selectedWorkspaceId: null
  })
}

/**
 * The main area of a project context, mounted client-side. Static markup cannot expose a re-render
 * loop, so only a real root exercises how the view subscribes to the project's workspaces.
 */
describe('ProjectContextView', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    useWorkspacesStore.setState({
      status: 'idle',
      error: null,
      byId: {},
      order: [],
      selectedWorkspaceId: null
    })
    useProjectContextStore.setState({ activeTab: {}, lastWorkspace: {} })
  })

  test('mounts and settles without a render loop', async () => {
    stubBridge()
    seedContext()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<ProjectContextView context={{ kind: 'project', id: 'p1' }} />)
      })

      expect(logged).toEqual([])
      expect(document.querySelector('.ix-ctx__title')?.textContent).toBe('SPOT')
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent)
      expect(tabs).toEqual(['Terminals', 'Kanban', 'Pull Requests', 'Worktrees', 'Overview'])
      // The scoped workspaces resolved, so the restore effect could claim the project's first one.
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('spot-api')
      expect(document.querySelector('[data-testid="split-stage"]')).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('re-entering a project restores the workspace it last showed', async () => {
    stubBridge()
    seedContext()
    useProjectContextStore.setState({ activeTab: {}, lastWorkspace: { p1: 'spot-web' } })

    await act(async () => {
      render(<ProjectContextView context={{ kind: 'project', id: 'p1' }} />)
    })

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('spot-web')
  })

  test('the Other bucket drops the binding-only sections and scopes to unassigned workspaces', async () => {
    stubBridge()
    seedContext()

    await act(async () => {
      render(<ProjectContextView context={{ kind: 'other' }} />)
    })

    const tabs = [...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent)
    expect(tabs).toEqual(['Terminals', 'Kanban', 'Pull Requests'])
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('scratch')
  })
})
