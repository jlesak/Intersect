import { describe, expect, test } from 'vitest'
import type { Project, Workspace } from '@common/domain'
import type { SidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { resolveShellContext, useShellStore } from './shellStore'

const Noop = (): null => null

function section(id: string, main: boolean): SidebarSection {
  return { id, order: 0, label: id, icon: Noop, ...(main ? { mainComponent: Noop } : {}) }
}

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

describe('shell context state', () => {
  test('selecting a section, project, and Other are mutually exclusive', () => {
    const s = useShellStore.getState()
    s.setActiveProject('p1')
    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'p1' })
    s.setActiveSection('todo')
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: 'todo' })
    s.setOtherContext()
    expect(useShellStore.getState().context).toEqual({ kind: 'other' })
  })
})

describe('resolveShellContext', () => {
  const sections = [section('dashboard', true), section('todo', true)]

  test('an explicit selection wins', () => {
    expect(resolveShellContext({ kind: 'section', id: 'todo' }, [project('a')], sections)).toEqual({
      kind: 'section',
      id: 'todo'
    })
    expect(resolveShellContext({ kind: 'other' }, [], sections)).toEqual({ kind: 'other' })
  })

  test('no selection falls back to the first project pin', () => {
    expect(resolveShellContext(null, [project('a'), project('b')], sections)).toEqual({
      kind: 'project',
      id: 'a'
    })
  })

  test('no selection and no projects falls back to the first main-owning section', () => {
    expect(resolveShellContext(null, [], sections)).toEqual({ kind: 'section', id: 'dashboard' })
  })

  test("no selection restores the selected workspace's home context first", () => {
    const workspace = (projectId: string | null): Workspace => ({
      id: 'w1',
      name: 'w1',
      folderPath: '/w1',
      layout: 'single',
      activeTabId: null,
      sortOrder: 0,
      projectId,
      projectSource: 'auto'
    })
    const projects = [project('a'), project('b')]
    expect(resolveShellContext(null, projects, sections, workspace('b'))).toEqual({
      kind: 'project',
      id: 'b'
    })
    expect(resolveShellContext(null, projects, sections, workspace(null))).toEqual({
      kind: 'other'
    })
    // A workspace pointing at a vanished project falls back to the first pin.
    expect(resolveShellContext(null, projects, sections, workspace('gone'))).toEqual({
      kind: 'project',
      id: 'a'
    })
  })

  test('a stale project selection (deleted or archived) re-resolves instead of dangling', () => {
    expect(resolveShellContext({ kind: 'project', id: 'gone' }, [project('a')], sections)).toEqual({
      kind: 'project',
      id: 'a'
    })
    expect(resolveShellContext({ kind: 'project', id: 'gone' }, [], sections)).toEqual({
      kind: 'section',
      id: 'dashboard'
    })
  })
})
