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
