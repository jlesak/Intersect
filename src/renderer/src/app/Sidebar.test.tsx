import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Project, Workspace } from '@common/domain'
import { useAttentionStore } from '@renderer/features/attention'
import { useProjectsStore } from '@renderer/features/projects'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import {
  __resetSidebarRegistryForTests,
  registerSidebarSection
} from '@renderer/shared/registries/sidebarRegistry'
import { Sidebar } from './Sidebar'
import { useShellStore } from './shellStore'

// The projects barrel reaches the project context view, whose panels transitively import monaco.
// The sidebar renders no editor, so an inert stand-in is enough to import the barrel's store.
vi.mock('monaco-editor', () => ({ editor: {} }))

const Icon = () => <span />

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

function project(id: string, name: string, sortOrder: number): Project {
  return {
    id,
    name,
    sortOrder,
    archived: false,
    repoPaths: [`/repos/${id}`],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: []
  }
}

const PROJECTS = [
  project('p1', 'SPOT', 0),
  project('p2', 'Atlas', 1),
  { ...project('p3', 'Legacy', 2), archived: true }
]

const WORKSPACES = [
  workspace('spot-api', { name: 'SPOT API', projectId: 'p1', projectSource: 'manual' }),
  workspace('spot-web', { name: 'SPOT Web', projectId: 'p1', sortOrder: 1 }),
  workspace('atlas', { name: 'Atlas', projectId: 'p2', sortOrder: 2 }),
  workspace('scratch', { name: 'Scratch', sortOrder: 3 })
]

/** The rail owns the projects load, so the bridge must answer it with the same seeded truth. */
function stubBridge(): void {
  ;(window as { intersect?: unknown }).intersect = {
    projects: {
      list: () => Promise.resolve(PROJECTS),
      listOverrides: () => Promise.resolve([])
    }
  }
}

/**
 * Two live projects plus an archived one, workspaces spread across both projects and the Other
 * bucket, and one waiting session in each bucket so every pin has a status to aggregate.
 */
function seedRail(): void {
  useProjectsStore.setState({ status: 'ready', error: null, overrides: [], projects: PROJECTS })
  useWorkspacesStore.setState({
    status: 'ready',
    error: null,
    byId: Object.fromEntries(WORKSPACES.map((w) => [w.id, w])),
    order: WORKSPACES.map((w) => w.id),
    selectedWorkspaceId: null
  })
  useAttentionStore.setState({
    status: {
      'spot-web:t1': { status: 'waiting', since: 1 },
      'atlas:t1': { status: 'working', since: 1 },
      'scratch:t1': { status: 'done', since: 1 }
    }
  })
}

const railLabels = (): (string | null)[] =>
  [...document.querySelectorAll('.ix-rail__label')].map((e) => e.textContent)

/**
 * The app sidebar, mounted client-side against a populated rail. Every pin subscribes to the
 * workspaces of one project - and the Other pin to the unassigned ones - so only a real root with
 * projects present exercises those subscriptions at all; an empty store renders no pin and proves
 * nothing. Static markup could not expose a re-render loop either.
 */
describe('Sidebar', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    __resetSidebarRegistryForTests()
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    useWorkspacesStore.setState({
      status: 'idle',
      error: null,
      byId: {},
      order: [],
      selectedWorkspaceId: null
    })
    useAttentionStore.setState({ status: {} })
    useShellStore.setState({ context: null, sidebarCollapsed: false })
  })

  test('mounts a populated rail and settles without a render loop', async () => {
    stubBridge()
    seedRail()
    registerSidebarSection({ id: 'dashboard', order: -1, label: 'Dashboard', icon: Icon })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<Sidebar />)
      })

      expect(logged).toEqual([])
      // Archived projects hold no pin, and the Other bucket always closes the pin run.
      expect(railLabels()).toEqual(['Dashboard', 'SPOT', 'Atlas', 'Other'])
      expect(document.querySelectorAll('.ix-rail__btn--project')).toHaveLength(2)

      // Each dot proves its pin's subscription resolved to that bucket's workspaces: SPOT
      // aggregates a waiting session, Atlas a working one, and Other the unassigned Scratch.
      const dots = [...document.querySelectorAll('.ix-rail__btn--project .ix-rail__dot')].map(
        (e) => e.className
      )
      expect(dots).toEqual(['ix-rail__dot ix-rail__dot--waiting', 'ix-rail__dot ix-rail__dot--working'])
      expect(document.querySelector('.ix-rail__btn--other .ix-rail__dot')?.className).toBe(
        'ix-rail__dot ix-rail__dot--done'
      )

      // No explicit context yet, so the first live project owns the body.
      expect(document.querySelector('.ix-rail__btn--project.ix-rail__btn--active')).toBeTruthy()
      const names = [...document.querySelectorAll('.ix-ws__name')].map((e) => e.textContent)
      expect(names).toEqual(['SPOT API', 'SPOT Web'])
    } finally {
      consoleError.mockRestore()
    }
  })

  test('the Other context mounts the same rail and scopes the body to unassigned workspaces', async () => {
    stubBridge()
    seedRail()
    useShellStore.setState({ context: { kind: 'other' }, sidebarCollapsed: false })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<Sidebar />)
      })

      expect(logged).toEqual([])
      expect(document.querySelector('.ix-rail__btn--other.ix-rail__btn--active')).toBeTruthy()
      const names = [...document.querySelectorAll('.ix-ws__name')].map((e) => e.textContent)
      expect(names).toEqual(['Scratch'])
    } finally {
      consoleError.mockRestore()
    }
  })

  test('switching to another project re-subscribes every pin without a render loop', async () => {
    stubBridge()
    seedRail()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<Sidebar />)
      })

      await act(async () => {
        useShellStore.getState().setActiveProject('p2')
      })

      expect(logged).toEqual([])
      const names = [...document.querySelectorAll('.ix-ws__name')].map((e) => e.textContent)
      expect(names).toEqual(['Atlas'])
    } finally {
      consoleError.mockRestore()
    }
  })
})
