import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, test } from 'vitest'
import { createProjectRepo, type ProjectRepo, type ProjectRepoDeps } from './projectRepo'
import { makeTestDb, makeTestDeps } from './testkit'

/**
 * Deterministic canonicalization for tests: anything under /link/... is a symlink alias of the
 * same tail under /real/..., everything else is already canonical.
 */
function makeProjectDeps(): ProjectRepoDeps {
  return {
    ...makeTestDeps(),
    canonicalize: (p) => (p.startsWith('/link/') ? '/real/' + p.slice('/link/'.length) : p)
  }
}

describe('projectRepo', () => {
  let db: DatabaseSync
  let repo: ProjectRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createProjectRepo(db, makeProjectDeps())
  })

  test('create binds one canonicalized repo folder and lists in manual order', () => {
    const a = repo.create('SPOT', '/link/spot')
    const b = repo.create('Intersect', '/real/intersect')
    expect(a).toEqual({
      id: 'id-1',
      name: 'SPOT',
      sortOrder: 0,
      archived: false,
      repoPaths: ['/real/spot'],
      jiraJql: null,
      jiraBoardUrl: null,
      adoRepositories: [],
      togglProjectId: null
    })
    expect(b.sortOrder).toBe(1)
    expect(repo.list().map((p) => p.id)).toEqual(['id-1', 'id-2'])
  })

  test('create rejects a blank name and a folder already bound elsewhere, even via symlink alias', () => {
    repo.create('SPOT', '/real/spot')
    expect(() => repo.create('  ', '/real/other')).toThrow('name must not be empty')
    expect(() => repo.create('Dup', '/real/spot')).toThrow('already bound to project "SPOT"')
    expect(() => repo.create('Dup', '/link/spot')).toThrow('already bound to project "SPOT"')
  })

  test('update edits name, Jira, ADO and Toggl bindings; omitted fields stay', () => {
    const p = repo.create('SPOT', '/real/spot')
    const updated = repo.update(p.id, {
      name: ' SPOT 2 ',
      jiraJql: ' project = FID2507 ',
      jiraBoardUrl: 'https://jira/board/1',
      adoRepositories: ['spot-backend', 'spot-frontend'],
      togglProjectId: 12345
    })
    expect(updated.name).toBe('SPOT 2')
    expect(updated.jiraJql).toBe('project = FID2507')
    expect(updated.jiraBoardUrl).toBe('https://jira/board/1')
    expect(updated.adoRepositories).toEqual(['spot-backend', 'spot-frontend'])
    expect(updated.togglProjectId).toBe(12345)

    const untouched = repo.update(p.id, { togglProjectId: null })
    expect(untouched.name).toBe('SPOT 2')
    expect(untouched.togglProjectId).toBeNull()
    expect(untouched.adoRepositories).toEqual(['spot-backend', 'spot-frontend'])
  })

  test('update normalizes blank Jira fields to null and validates inputs', () => {
    const p = repo.create('SPOT', '/real/spot')
    const cleared = repo.update(p.id, { jiraJql: '  ', jiraBoardUrl: '' })
    expect(cleared.jiraJql).toBeNull()
    expect(cleared.jiraBoardUrl).toBeNull()
    expect(() => repo.update(p.id, { name: ' ' })).toThrow('name must not be empty')
    expect(() => repo.update(p.id, { togglProjectId: 1.5 })).toThrow('Invalid Toggl project id')
    expect(() => repo.update(p.id, { adoRepositories: ['a', ' a '] })).toThrow(
      'ADO repository names must be unique'
    )
    expect(() => repo.update('missing', { name: 'X' })).toThrow('Project not found')
  })

  test('a failed update rolls back every part of it', () => {
    const p = repo.create('SPOT', '/real/spot')
    repo.update(p.id, { adoRepositories: ['keep-me'] })
    expect(() =>
      repo.update(p.id, { adoRepositories: ['new-a', 'new-a'], name: 'Renamed' })
    ).toThrow()
    const after = repo.getById(p.id)!
    expect(after.name).toBe('SPOT')
    expect(after.adoRepositories).toEqual(['keep-me'])
  })

  test('archive is reversible app-state', () => {
    const p = repo.create('SPOT', '/real/spot')
    expect(repo.setArchived(p.id, true).archived).toBe(true)
    expect(repo.setArchived(p.id, false).archived).toBe(false)
  })

  test('reorder replaces the full ordering transactionally and validates the permutation', () => {
    const a = repo.create('A', '/real/a')
    const b = repo.create('B', '/real/b')
    const c = repo.create('C', '/real/c')
    const reordered = repo.reorder([c.id, a.id, b.id])
    expect(reordered.map((p) => p.id)).toEqual([c.id, a.id, b.id])
    expect(reordered.map((p) => p.sortOrder)).toEqual([0, 1, 2])
    expect(() => repo.reorder([a.id, b.id])).toThrow('every project exactly once')
    expect(() => repo.reorder([a.id, b.id, b.id])).toThrow('every project exactly once')
  })

  test('addRepoPath appends bindings; duplicates are rejected across all projects', () => {
    const a = repo.create('A', '/real/a')
    repo.create('B', '/real/b')
    const withMore = repo.addRepoPath(a.id, '/real/a2')
    expect(withMore.repoPaths).toEqual(['/real/a', '/real/a2'])
    expect(() => repo.addRepoPath(a.id, '/link/b')).toThrow('already bound to project "B"')
    expect(() => repo.addRepoPath(a.id, '/real/a2')).toThrow('already bound to project "A"')
  })

  test('removeRepoPath unbinds by canonical equivalence but keeps the last binding', () => {
    const a = repo.create('A', '/real/a')
    repo.addRepoPath(a.id, '/real/a2')
    const left = repo.removeRepoPath(a.id, '/link/a2')
    expect(left.repoPaths).toEqual(['/real/a'])
    expect(() => repo.removeRepoPath(a.id, '/real/a')).toThrow('at least one repository folder')
    expect(() => repo.removeRepoPath(a.id, '/real/never')).toThrow('not bound to this project')
  })

  test('remove deletes the project and its bindings and detaches its workspaces', () => {
    const p = repo.create('A', '/real/a')
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at,project_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/real/a', 'single', null, 0, 1, p.id)
    repo.remove(p.id)
    expect(repo.list()).toEqual([])
    expect((db.prepare('SELECT count(*) AS c FROM project_repo').get() as { c: number }).c).toBe(0)
    expect(
      db.prepare("SELECT project_id AS x FROM workspaces WHERE id='w1'").get()
    ).toEqual({ x: null })
  })

  test('migrated workspace-projects are readable through the repo', () => {
    // Simulates rows created by migration 13 (project id = legacy workspace id, path as stored).
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('w-legacy', 'Legacy', 0, 0, 1)
    db.prepare(
      'INSERT INTO project_repo (project_id,path,sort_order,created_at) VALUES (?,?,?,?)'
    ).run('w-legacy', '/link/legacy', 0, 1)
    const p = repo.getById('w-legacy')!
    expect(p.repoPaths).toEqual(['/link/legacy'])
    // The alias is recognized as equivalent when someone tries to bind its canonical twin.
    expect(() => repo.create('Twin', '/real/legacy')).toThrow('already bound to project "Legacy"')
  })
})
