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
