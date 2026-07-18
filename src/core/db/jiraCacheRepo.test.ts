import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import type { JiraIssueSnapshot } from '@common/domain'
import { runMigrations } from './migrations'
import { createJiraCacheRepo } from './jiraCacheRepo'
import { makeTestDb } from './testkit'

const snapshot = (key: string, over: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot => ({
  key,
  url: `https://jira.skoda.vwgroup.com/browse/${key}`,
  summary: `Issue ${key}`,
  column: 'todo',
  priority: 'high',
  updatedAt: 1000,
  description: null,
  rawStatus: 'To Do',
  rawPriority: 'High',
  assignee: null,
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  fetchedAt: 1000,
  absent: false,
  ...over
})

describe('jiraCacheRepo', () => {
  test('returns null for a source that never synced', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    expect(repo.getBoard('global')).toBeNull()
  })

  test('round-trips a successful sync, newest activity first', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1', { updatedAt: 1 }), snapshot('A-2', { updatedAt: 2 })], 42, false)
    const board = repo.getBoard('global')
    expect(board?.fetchedAt).toBe(42)
    expect(board?.partial).toBe(false)
    expect(board?.error).toBeNull()
    expect(board?.issues.map((i) => i.key)).toEqual(['A-2', 'A-1'])
  })

  test('issue identity is stable: re-syncing the same key updates the row in place', () => {
    const db = makeTestDb()
    const repo = createJiraCacheRepo(db)
    repo.putSuccess('global', [snapshot('A-1', { summary: 'old', rawStatus: 'To Do' })], 1, false)
    repo.putSuccess('global', [snapshot('A-1', { summary: 'new', rawStatus: 'In Progress' })], 2, false)
    const rows = db.prepare(`SELECT count(*) AS c FROM jira_issue_cache`).get() as { c: number }
    expect(rows.c).toBe(1)
    const board = repo.getBoard('global')
    expect(board?.issues[0].summary).toBe('new')
    expect(board?.issues[0].rawStatus).toBe('In Progress')
  })

  test('issues missing from the latest fetch are marked absent, never deleted', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1'), snapshot('A-2')], 1, false)
    repo.putSuccess('global', [snapshot('A-2')], 2, false)
    const board = repo.getBoard('global')
    expect(board?.issues).toHaveLength(2)
    const byKey = Object.fromEntries(board!.issues.map((i) => [i.key, i.absent]))
    expect(byKey['A-1']).toBe(true)
    expect(byKey['A-2']).toBe(false)
  })

  test('a reappearing issue is unmarked', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1')], 1, false)
    repo.putSuccess('global', [], 2, false)
    repo.putSuccess('global', [snapshot('A-1')], 3, false)
    expect(repo.getBoard('global')?.issues[0].absent).toBe(false)
  })

  test('an error retains the last-good issues and fetch time alongside the error', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1')], 42, false)
    repo.putError('global', { kind: 'auth', message: 'expired' })
    const board = repo.getBoard('global')
    expect(board?.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(board?.fetchedAt).toBe(42)
    expect(board?.error).toEqual({ kind: 'auth', message: 'expired' })
  })

  test('an error before any success reports a null fetch time', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putError('global', { kind: 'network', message: 'fetch failed' })
    const board = repo.getBoard('global')
    expect(board?.fetchedAt).toBeNull()
    expect(board?.issues).toEqual([])
    expect(board?.error?.kind).toBe('network')
  })

  test('a later success clears the error and the partial flag round-trips', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putError('global', { kind: 'server', message: 'HTTP 500' })
    repo.putSuccess('global', [snapshot('A-1')], 7, true)
    const board = repo.getBoard('global')
    expect(board?.error).toBeNull()
    expect(board?.partial).toBe(true)
  })

  test('sources are isolated: a project sync never touches the global board', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('G-1')], 1, false)
    repo.putSuccess('project:p1', [snapshot('P-1')], 2, false)
    repo.putError('project:p1', { kind: 'other', message: 'boom' })
    expect(repo.getBoard('global')?.issues.map((i) => i.key)).toEqual(['G-1'])
    expect(repo.getBoard('global')?.error).toBeNull()
    expect(repo.getBoard('project:p1')?.issues.map((i) => i.key)).toEqual(['P-1'])
  })
})

describe('migration 17: legacy my_work_cache seeds the global source', () => {
  test('the legacy board becomes global cache rows and the legacy table is dropped', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, 16)
    const legacyIssues = [
      {
        key: 'FID2507-1',
        url: 'https://jira.skoda.vwgroup.com/browse/FID2507-1',
        summary: 'Legacy issue',
        column: 'progress',
        priority: 'high',
        updatedAt: 555
      }
    ]
    db.prepare(`INSERT INTO my_work_cache (key, issues_json, fetched_at) VALUES ('board', ?, ?)`).run(
      JSON.stringify(legacyIssues),
      777
    )

    runMigrations(db)

    const repo = createJiraCacheRepo(db)
    const board = repo.getBoard('global')
    expect(board?.fetchedAt).toBe(777)
    expect(board?.error).toBeNull()
    expect(board?.issues).toHaveLength(1)
    expect(board?.issues[0]).toMatchObject({
      key: 'FID2507-1',
      summary: 'Legacy issue',
      column: 'progress',
      priority: 'high',
      updatedAt: 555,
      description: null,
      rawStatus: '',
      absent: false,
      fetchedAt: 777
    })

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).not.toContain('my_work_cache')
    expect(tables).toEqual(expect.arrayContaining(['jira_issue_cache', 'jira_sync_state']))
  })

  test('an empty legacy cache migrates to a never-synced global source', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, 16)
    runMigrations(db)
    expect(createJiraCacheRepo(db).getBoard('global')).toBeNull()
  })

  test('a corrupt legacy snapshot seeds nothing but the migration still completes', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, 16)
    db.prepare(`INSERT INTO my_work_cache (key, issues_json, fetched_at) VALUES ('board', 'not json', 1)`).run()
    expect(() => runMigrations(db)).not.toThrow()
    expect(createJiraCacheRepo(db).getBoard('global')).toBeNull()
  })

  test('issuePresence looks across sources: present anywhere beats absent, no row is unknown', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1'), snapshot('A-2')], 1, false)
    repo.putSuccess('project:p1', [snapshot('A-1')], 2, false)
    // A-2 vanished from the global fetch; A-1 stays present through the project source.
    repo.putSuccess('global', [snapshot('A-3')], 3, false)
    expect(repo.issuePresence('A-1')).toBe('present')
    expect(repo.issuePresence('A-2')).toBe('absent')
    expect(repo.issuePresence('A-3')).toBe('present')
    expect(repo.issuePresence('NOPE-1')).toBe('unknown')
  })

  test('listAllIssues dedupes by key across sources, preferring present then freshest rows', () => {
    const repo = createJiraCacheRepo(makeTestDb())
    repo.putSuccess('global', [snapshot('A-1', { summary: 'stale copy' }), snapshot('A-2')], 1, false)
    repo.putSuccess('project:p1', [snapshot('A-1', { summary: 'fresh copy' }), snapshot('B-1')], 2, false)
    // A-2 drops from the next global fetch but must still be listed (marked absent).
    repo.putSuccess('global', [snapshot('A-1', { summary: 'stale copy' })], 3, false)
    const issues = repo.listAllIssues()
    expect(issues.map((i) => i.key).sort()).toEqual(['A-1', 'A-2', 'B-1'])
    expect(issues.find((i) => i.key === 'A-1')?.summary).toBe('stale copy')
    expect(issues.find((i) => i.key === 'A-2')?.absent).toBe(true)
  })
})
