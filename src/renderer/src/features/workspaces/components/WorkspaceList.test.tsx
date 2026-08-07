import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Project, Workspace } from '@common/domain'
import { useAttentionStore } from '@renderer/features/attention'
import { useProjectsStore } from '@renderer/features/projects'
import { useWorkspacesStore } from '../store'
import { WorkspaceList } from './WorkspaceList'

// The projects barrel reaches the project context view, whose panels transitively import monaco.
// The sidebar renders no editor, so an inert stand-in is enough to import the barrel's store.
vi.mock('monaco-editor', () => ({ editor: {} }))

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    folderPath: `/repos/${id}`,
    layout: 'single',
    activeTabId: null,
    sortOrder: 0,
    projectId: null,
    projectSource: 'auto',
    ...over
  }
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    sortOrder: 0,
    archived: false,
    repoPaths: [`/repos/${id}`],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: []
  }
}

/** Three workspaces across two projects and the Other bucket, with one of them selected. */
function seedSidebar(): void {
  useWorkspacesStore.setState({
    status: 'ready',
    error: null,
    byId: {
      spot: workspace('spot', { name: 'SPOT', projectId: 'p1', projectSource: 'manual' }),
      atlas: workspace('atlas', { name: 'Atlas', projectId: 'p2', sortOrder: 1 }),
      scratch: workspace('scratch', { name: 'Scratch', sortOrder: 2 })
    },
    order: ['spot', 'atlas', 'scratch'],
    selectedWorkspaceId: 'atlas'
  })
  useProjectsStore.setState({
    status: 'ready',
    error: null,
    overrides: [],
    projects: [project('p1', 'SPOT'), project('p2', 'Atlas'), { ...project('p3', 'Legacy'), archived: true }]
  })
}

/**
 * The sidebar workspace list, mounted client-side. Static markup cannot expose a re-render loop, so
 * only a real root exercises how the list subscribes to the workspaces and to the active projects.
 */
describe('WorkspaceList', () => {
  afterEach(() => {
    useWorkspacesStore.setState({
      status: 'idle',
      error: null,
      byId: {},
      order: [],
      selectedWorkspaceId: null
    })
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    useAttentionStore.setState({ status: {} })
  })

  test('mounts and settles without a render loop', async () => {
    seedSidebar()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<WorkspaceList />)
      })

      expect(logged).toEqual([])
      const names = [...document.querySelectorAll('.ix-ws__name')].map((e) => e.textContent)
      expect(names).toEqual(['SPOT', 'Atlas', 'Scratch'])
      expect(document.querySelectorAll('.ix-ws--active')).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a project scope narrows the mounted list to that project’s workspaces', async () => {
    seedSidebar()

    await act(async () => {
      render(<WorkspaceList projectScope="p1" />)
    })

    const names = [...document.querySelectorAll('.ix-ws__name')].map((e) => e.textContent)
    expect(names).toEqual(['SPOT'])
  })
})
