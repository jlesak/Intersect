import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Project } from '@common/domain'

// Jumping to a waiting session is navigation the attention wiring already owns; stubbing it keeps
// this test on command dispatch and out of workspace hydration.
const navigateMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./attentionWiring', () => ({ navigateToSession: navigateMock }))

import { useAttentionStore } from '@renderer/features/attention'
import { useProjectsStore } from '@renderer/features/projects'
import {
  getCommand,
  __resetCommandRegistryForTests
} from '@renderer/shared/registries/commandRegistry'
import { nextProject, registerShellCommands } from './shellCommands'
import { useShellStore } from './shellStore'

function project(id: string, archived = false): Project {
  return {
    id,
    name: id,
    sortOrder: 0,
    archived,
    repoPaths: [`/repos/${id}`],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null
  }
}

function seedProjects(...projects: Project[]): void {
  useProjectsStore.setState({ status: 'ready', projects })
}

beforeEach(() => {
  __resetCommandRegistryForTests()
  vi.clearAllMocks()
  useShellStore.setState({ context: null, sidebarCollapsed: false })
  useAttentionStore.setState({ status: {} })
  seedProjects()
})

describe('nextProject', () => {
  test('walks the pin order and wraps past the last one', () => {
    seedProjects(project('p1'), project('p2'), project('p3'))
    useShellStore.getState().setActiveProject('p2')

    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p3' })

    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p1' })
  })

  test('skips archived projects', () => {
    seedProjects(project('p1'), project('p2', true), project('p3'))
    useShellStore.getState().setActiveProject('p1')

    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p3' })
  })

  // Outside a project context - a global section, or Other - there is no "next", so the cycle
  // starts at the beginning rather than doing nothing.
  test('starts at the first project when a section owns the screen', () => {
    seedProjects(project('p1'), project('p2'))
    useShellStore.getState().setActiveSection('todo')

    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p1' })
  })

  // One project still counts as somewhere to go when the screen is not already on it.
  test('enters the only project from a global section', () => {
    seedProjects(project('p1'))
    useShellStore.getState().setActiveSection('todo')
    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p1' })
  })

  test('stays put when the only project is already on screen', () => {
    seedProjects(project('p1'))
    useShellStore.getState().setActiveProject('p1')
    nextProject()
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p1' })
  })

  test('does nothing with no projects at all', () => {
    nextProject()
    expect(useShellStore.getState().context).toBeNull()
  })
})

describe('registerShellCommands', () => {
  beforeEach(() => {
    registerShellCommands()
  })

  test('toggling the sidebar flips the collapsed state', () => {
    void getCommand('shell.toggleSidebar')?.handler()
    expect(useShellStore.getState().sidebarCollapsed).toBe(true)
  })

  test('switching project cycles the pins', () => {
    seedProjects(project('p1'), project('p2'))
    useShellStore.getState().setActiveProject('p1')

    void getCommand('projects.next')?.handler()

    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p2' })
  })

  test('jumping to a waiting session navigates to the one waiting longest', () => {
    useAttentionStore.setState({
      status: {
        'w1:fresh': { status: 'waiting', since: 5_000 },
        'w1:stale': { status: 'waiting', since: 1_000 },
        'w1:busy': { status: 'working', since: 100 }
      }
    })

    void getCommand('attention.jumpOldestWaiting')?.handler()

    expect(navigateMock).toHaveBeenCalledWith('w1:stale')
  })

  test('jumping with nothing waiting navigates nowhere', () => {
    useAttentionStore.setState({ status: { 'w1:busy': { status: 'working', since: 100 } } })

    void getCommand('attention.jumpOldestWaiting')?.handler()

    expect(navigateMock).not.toHaveBeenCalled()
  })

  test('every registered title matches what the native menu shows', () => {
    expect(getCommand('shell.toggleSidebar')?.title).toBe('Toggle Sidebar')
    expect(getCommand('projects.next')?.title).toBe('Switch Project')
    expect(getCommand('attention.jumpOldestWaiting')?.title).toBe('Jump to Waiting Session')
  })
})
