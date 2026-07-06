import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { openDatabase } from './connection'
import { CURRENT_VERSION } from './migrations'

describe('openDatabase', () => {
  test('opens a migrated on-disk database with WAL and foreign keys on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-db-'))
    const db = openDatabase(dir)
    try {
      expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
        CURRENT_VERSION
      )
      expect(
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
      ).toBe('wal')

      // Schema is usable and the cascade FK is active.
      db.prepare(
        'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
      ).run('w', 'W', '/x', 'single', null, 0, 1)
      db.prepare(
        'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
      ).run('t', 'w', 'T', 'shell', null, 0, 1)
      db.prepare('DELETE FROM workspaces WHERE id=?').run('w')
      expect((db.prepare('SELECT count(*) AS c FROM tabs').get() as { c: number }).c).toBe(0)
    } finally {
      db.close()
    }
  })
})
