import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { CURRENT_VERSION, runMigrations } from './migrations'

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('migrations', () => {
  test('a fresh database is migrated to the current version', () => {
    const db = new DatabaseSync(':memory:')
    expect(userVersion(db)).toBe(0)
    runMigrations(db)
    expect(userVersion(db)).toBe(CURRENT_VERSION)
  })

  test('creates the workspaces, tabs and app_state tables', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['workspaces', 'tabs', 'app_state']))
  })

  test('is idempotent - running again does not throw and keeps the version', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(userVersion(db)).toBe(CURRENT_VERSION)
  })

  test('pr_cache accepts my_vote and the pr_review_watermark table exists', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, my_vote, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', 'approved', '[]', 1)`
    ).run()
    expect(
      (db.prepare('SELECT my_vote AS v FROM pr_cache').get() as { v: string }).v
    ).toBe('approved')
    db.prepare(
      `INSERT INTO pr_review_watermark (repository_id, pr_id, voted_commit_id, updated_at)
       VALUES ('r', 1, 'sc', 1)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM pr_review_watermark').get() as { c: number }).c
    ).toBe(1)
  })

  test('pr_cache accepts my_reviewer_id and rows written without it read as NULL', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, my_vote, my_reviewer_id, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', 'approved', 'me-uuid', '[]', 1)`
    ).run()
    // A legacy-shaped insert (as rows cached before the column existed) leaves the column NULL.
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, reviewers_json, synced_at)
       VALUES ('r', 2, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', '[]', 1)`
    ).run()
    expect(
      (db.prepare('SELECT my_reviewer_id AS v FROM pr_cache WHERE pr_id = 1').get() as { v: string }).v
    ).toBe('me-uuid')
    expect(
      (db.prepare('SELECT my_reviewer_id AS v FROM pr_cache WHERE pr_id = 2').get() as { v: string | null }).v
    ).toBeNull()
  })

  test('the time tracking tables accept manual entries and session overrides', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO time_entry_manual (id, day, description, issue_key, duration_ms, created_at)
       VALUES ('m1', '2026-07-06', 'Team sync', NULL, 1800000, 1)`
    ).run()
    db.prepare(
      `INSERT INTO time_entry_override (session_id, issue_key, duration_ms, updated_at)
       VALUES ('s1', 'FID2507-611', 3600000, 1)`
    ).run()
    expect(
      (db.prepare('SELECT deleted AS d FROM time_entry_override').get() as { d: number }).d
    ).toBe(0)
    expect(
      (db.prepare('SELECT count(*) AS c FROM time_entry_manual').get() as { c: number }).c
    ).toBe(1)
  })

  test('the todo table accepts open and done tasks with an optional due day', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t1', 'Ask Marek about the review', '2026-07-10', 0, NULL, 1)`
    ).run()
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t2', 'Order a monitor', NULL, 1, 42, 2)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM todo_task WHERE done_at IS NULL').get() as { c: number }).c
    ).toBe(1)
    expect(
      (db.prepare("SELECT due_day AS d FROM todo_task WHERE id = 't1'").get() as { d: string }).d
    ).toBe('2026-07-10')
  })

  test('pr_cache defaults active_thread_count to 0 for rows inserted without it', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u',
               'author', '[]', 1)`
    ).run()
    const row = db
      .prepare('SELECT active_thread_count AS c FROM pr_cache WHERE pr_id = 1')
      .get() as { c: number }
    expect(row.c).toBe(0)
  })

  test('the todo table defaults priority to 4 and description to empty for rows inserted without them', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t1', 'Order a monitor', NULL, 0, NULL, 1)`
    ).run()
    const row = db
      .prepare("SELECT priority AS p, description AS d FROM todo_task WHERE id = 't1'")
      .get() as { p: number; d: string }
    expect(row.p).toBe(4)
    expect(row.d).toBe('')
  })

  test('priority-era TODO rows seed one exact manual order without losing content', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const insert = db.prepare(
      `INSERT INTO todo_task
         (id, text, description, due_day, priority, sort_order, done_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('p4', 'No priority', 'keep p4', null, 4, 0, null, 100)
    insert.run('p2-none', 'No due day', 'keep none', null, 2, 1, null, 101)
    insert.run('p2-later', 'Later', 'keep later', '2026-08-01', 2, 2, null, 102)
    insert.run('p1', 'Urgent', 'keep urgent', null, 1, 3, null, 103)
    insert.run('p2-sooner', 'Sooner', 'keep sooner', '2026-07-20', 2, 4, null, 104)
    insert.run('tie-b', 'Tie B', 'keep tie b', null, 3, 7, null, 105)
    insert.run('tie-a', 'Tie A', 'keep tie a', null, 3, 7, null, 105)
    insert.run('done', 'Completed', 'keep done', '2026-01-01', 1, 77, 999, 99)

    // The fixture represents a database whose last applied migration was the priority-era schema.
    db.exec('PRAGMA user_version = 11')
    runMigrations(db)

    const open = db
      .prepare(
        `SELECT id, text, description, due_day AS dueDay, priority, sort_order AS sortOrder,
                done_at AS doneAt, created_at AS createdAt
         FROM todo_task WHERE done_at IS NULL ORDER BY sort_order`
      )
      .all() as unknown as Array<Record<string, unknown>>
    expect(open.map((row) => row.id)).toEqual([
      'p1',
      'p2-sooner',
      'p2-later',
      'p2-none',
      'tie-a',
      'tie-b',
      'p4'
    ])
    expect(open.map((row) => row.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(open.find((row) => row.id === 'p2-sooner')).toEqual({
      id: 'p2-sooner',
      text: 'Sooner',
      description: 'keep sooner',
      dueDay: '2026-07-20',
      priority: 2,
      sortOrder: 1,
      doneAt: null,
      createdAt: 104
    })
    expect(
      db.prepare("SELECT sort_order AS n, description AS d FROM todo_task WHERE id = 'done'").get()
    ).toEqual({ n: 77, d: 'keep done' })
    expect((db.prepare('SELECT count(*) AS n FROM todo_task').get() as { n: number }).n).toBe(8)

    const snapshot = db.prepare('SELECT * FROM todo_task ORDER BY id').all()
    runMigrations(db)
    expect(db.prepare('SELECT * FROM todo_task ORDER BY id').all()).toEqual(snapshot)
  })

  test('deleting a workspace cascades to its tabs', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1)
    db.prepare(
      'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('t1', 'w1', 'T', 'shell', null, 0, 1)
    db.prepare('DELETE FROM workspaces WHERE id=?').run('w1')
    expect((db.prepare('SELECT count(*) AS c FROM tabs').get() as { c: number }).c).toBe(0)
  })

  test('rejects a tab with an invalid preset (CHECK constraint)', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1)
    expect(() =>
      db
        .prepare(
          'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('t1', 'w1', 'T', 'browser', null, 0, 1)
    ).toThrow()
  })
})
