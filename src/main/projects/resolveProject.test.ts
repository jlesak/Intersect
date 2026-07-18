import { describe, expect, test } from 'vitest'
import type { Project } from '@common/domain'
import { resolveProjectForPath, type ProjectPathDeps } from './resolveProject'

function project(partial: Partial<Project> & Pick<Project, 'id' | 'repoPaths'>): Project {
  return {
    name: partial.id,
    sortOrder: 0,
    archived: false,
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null,
    ...partial
  }
}

/** /link/... is a symlink alias of /real/...; /wt/... are worktrees of the mapped parent. */
function makeDeps(worktrees: Record<string, string> = {}): ProjectPathDeps {
  return {
    canonicalize: (p) => (p.startsWith('/link/') ? '/real/' + p.slice('/link/'.length) : p),
    worktreeParentRoot: (p) => {
      const root = Object.keys(worktrees).find((w) => p === w || p.startsWith(w + '/'))
      return root ? worktrees[root] : null
    }
  }
}

describe('resolveProjectForPath', () => {
  test('matches a cwd inside a bound folder and prefers the longest binding', () => {
    const projects = [
      project({ id: 'outer', repoPaths: ['/real/mono'] }),
      project({ id: 'inner', repoPaths: ['/real/mono/packages/app'] })
    ]
    const deps = makeDeps()
    expect(resolveProjectForPath('/real/mono/src', projects, deps)).toBe('outer')
    expect(resolveProjectForPath('/real/mono/packages/app/src', projects, deps)).toBe('inner')
    expect(resolveProjectForPath('/real/mono/packages/app', projects, deps)).toBe('inner')
  })

  test('a sibling folder sharing a name prefix never matches', () => {
    const projects = [project({ id: 'spot', repoPaths: ['/real/spot'] })]
    expect(resolveProjectForPath('/real/spot2', projects, makeDeps())).toBeNull()
    expect(resolveProjectForPath('/real/spot2/src', projects, makeDeps())).toBeNull()
  })

  test('symlink aliases of the cwd and of the binding both resolve', () => {
    const viaBinding = [project({ id: 'spot', repoPaths: ['/link/spot'] })]
    expect(resolveProjectForPath('/real/spot/src', viaBinding, makeDeps())).toBe('spot')
    const viaCwd = [project({ id: 'spot', repoPaths: ['/real/spot'] })]
    expect(resolveProjectForPath('/link/spot/src', viaCwd, makeDeps())).toBe('spot')
  })

  test('any of a project\'s multiple bindings matches', () => {
    const projects = [project({ id: 'spot', repoPaths: ['/real/spot', '/real/spot-backend'] })]
    expect(resolveProjectForPath('/real/spot-backend/src', projects, makeDeps())).toBe('spot')
  })

  test('a worktree resolves through its parent repository binding', () => {
    const projects = [project({ id: 'spot', repoPaths: ['/real/spot'] })]
    const deps = makeDeps({ '/real/worktrees/spot-fix': '/real/spot' })
    expect(resolveProjectForPath('/real/worktrees/spot-fix/src', projects, deps)).toBe('spot')
  })

  test('a directly-bound worktree wins over its parent repository binding', () => {
    const projects = [
      project({ id: 'parent', repoPaths: ['/real/spot'] }),
      project({ id: 'wt', repoPaths: ['/real/worktrees/spot-fix'] })
    ]
    const deps = makeDeps({ '/real/worktrees/spot-fix': '/real/spot' })
    expect(resolveProjectForPath('/real/worktrees/spot-fix', projects, deps)).toBe('wt')
  })

  test('unmatched and missing paths resolve to the virtual Other bucket (null)', () => {
    const projects = [project({ id: 'spot', repoPaths: ['/real/spot'] })]
    expect(resolveProjectForPath('/somewhere/else', projects, makeDeps())).toBeNull()
    expect(resolveProjectForPath('/somewhere/else', [], makeDeps())).toBeNull()
  })

  test('archived projects never receive new work', () => {
    const projects = [project({ id: 'spot', repoPaths: ['/real/spot'], archived: true })]
    expect(resolveProjectForPath('/real/spot/src', projects, makeDeps())).toBeNull()
  })

  test('equivalent bindings on two projects tie-break by manual order, then id', () => {
    const bySort = [
      project({ id: 'b', repoPaths: ['/real/spot'], sortOrder: 1 }),
      project({ id: 'a', repoPaths: ['/real/spot'], sortOrder: 0 })
    ]
    expect(resolveProjectForPath('/real/spot/src', bySort, makeDeps())).toBe('a')
    const byId = [
      project({ id: 'z', repoPaths: ['/real/spot'], sortOrder: 0 }),
      project({ id: 'a', repoPaths: ['/link/spot'], sortOrder: 0 })
    ]
    expect(resolveProjectForPath('/real/spot/src', byId, makeDeps())).toBe('a')
  })
})
