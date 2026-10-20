import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  DatabaseSetAsideError,
  DatabaseStartupError,
  openDatabase,
  setAsideDatabase,
  type SetAsideFs
} from './connection'
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

  /** What opening throws, so a test can assert on the error itself rather than only its text. */
  const openError = (dir: string): unknown => {
    try {
      openDatabase(dir).close()
    } catch (err) {
      return err
    }
    throw new Error('openDatabase was expected to fail')
  }

  test('a file that is not a database fails as a database startup error without the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-db-'))
    writeFileSync(join(dir, 'intersect.db'), 'x'.repeat(4096))

    const err = openError(dir)
    expect(err).toBeInstanceOf(DatabaseStartupError)
    expect((err as Error).message).toBe('could not open the database: file is not a database')
    expect((err as Error).message).not.toContain(dir)
  })

  test('a failing migration fails as a database startup error naming the migration, and releases the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-db-'))
    const seed = new DatabaseSync(join(dir, 'intersect.db'))
    seed.exec('CREATE TABLE workspaces(x)')
    seed.close()

    const err = openError(dir)
    expect(err).toBeInstanceOf(DatabaseStartupError)
    expect((err as Error).message).toBe(
      'database migration 1 failed: table workspaces already exists'
    )
    // A handle left open would checkpoint and delete the WAL by name when it is collected, which
    // after a set-aside is the fresh database's WAL. Closing it leaves no companion files behind.
    expect(readdirSync(dir).sort()).toEqual(['intersect.db'])
  })
})

describe('setAsideDatabase', () => {
  const NOW = new Date(2026, 9, 20, 10, 15, 3)
  const STAMP = 'intersect-set-aside-20261020-101503'
  const SOURCES = ['intersect.db', 'intersect.db-wal', 'intersect.db-shm']

  /** A profile directory holding the named database files, each with its own name as content. */
  const profile = (names: string[] = SOURCES): string => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-setaside-'))
    for (const name of names) writeFileSync(join(dir, name), name)
    return dir
  }

  /**
   * The real filesystem, recording every rename by file names and refusing the renames listed in
   * `failOn` (keyed `from>to`) with the given error code.
   */
  const recordingFs = (
    failOn: Record<string, string> = {}
  ): SetAsideFs & { renames: string[] } => {
    const renames: string[] = []
    return {
      renames,
      exists: (path) => existsSync(path),
      rename: (from, to) => {
        const key = `${basename(from)}>${basename(to)}`
        renames.push(key)
        const code = failOn[key]
        if (code) throw Object.assign(new Error(`${code}: refused`), { code })
        renameSync(from, to)
      }
    }
  }

  const content = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8')

  const thrown = (op: () => unknown): Error => {
    try {
      op()
    } catch (err) {
      return err as Error
    }
    throw new Error('expected a throw')
  }

  test('moves the database and both companion files to dated names in the same folder', () => {
    const dir = profile()

    const result = setAsideDatabase(dir, NOW)

    expect(result).toEqual({
      from: SOURCES,
      to: [`${STAMP}.db`, `${STAMP}.db-wal`, `${STAMP}.db-shm`]
    })
    expect(readdirSync(dir).sort()).toEqual(
      [`${STAMP}.db`, `${STAMP}.db-shm`, `${STAMP}.db-wal`].sort()
    )
    expect(content(dir, `${STAMP}.db`)).toBe('intersect.db')
    expect(content(dir, `${STAMP}.db-wal`)).toBe('intersect.db-wal')
    expect(content(dir, `${STAMP}.db-shm`)).toBe('intersect.db-shm')
  })

  test('skips companion files that do not exist', () => {
    const dir = profile(['intersect.db'])

    expect(setAsideDatabase(dir, NOW)).toEqual({ from: ['intersect.db'], to: [`${STAMP}.db`] })
    expect(readdirSync(dir)).toEqual([`${STAMP}.db`])
  })

  test('a taken target refuses before any rename and leaves every file where it was', () => {
    const dir = profile([...SOURCES, `${STAMP}.db-wal`])
    const fs = recordingFs()

    const err = thrown(() => setAsideDatabase(dir, NOW, fs))

    expect(err).toBeInstanceOf(DatabaseSetAsideError)
    expect(err.message).toContain(`${STAMP}.db-wal already exists`)
    expect(fs.renames).toEqual([])
    for (const name of SOURCES) expect(content(dir, name)).toBe(name)
    expect(content(dir, `${STAMP}.db-wal`)).toBe(`${STAMP}.db-wal`)
  })

  test('a failed WAL rename moves the database back, so no target is left behind', () => {
    const dir = profile()
    const fs = recordingFs({ [`intersect.db-wal>${STAMP}.db-wal`]: 'EACCES' })

    const err = thrown(() => setAsideDatabase(dir, NOW, fs))

    expect(err).toBeInstanceOf(DatabaseSetAsideError)
    expect(err.message).toMatch(/^could not set the database aside: /)
    expect(err.message).toContain('renaming intersect.db-wal failed (EACCES)')
    expect(fs.renames).toEqual([
      `intersect.db>${STAMP}.db`,
      `intersect.db-wal>${STAMP}.db-wal`,
      `${STAMP}.db>intersect.db`
    ])
    expect(readdirSync(dir).sort()).toEqual([...SOURCES].sort())
    for (const name of SOURCES) expect(content(dir, name)).toBe(name)
    // The card tells the user where each file is; after a clean rollback that is home, for all.
    expect(err.message).toContain(
      'Where the files are now: intersect.db is under its own name; ' +
        'intersect.db-wal is under its own name; intersect.db-shm is under its own name.'
    )
  })

  test('a failed shared-memory rename moves both earlier files back, latest first', () => {
    const dir = profile()
    const fs = recordingFs({ [`intersect.db-shm>${STAMP}.db-shm`]: 'EIO' })

    const err = thrown(() => setAsideDatabase(dir, NOW, fs))

    expect(err).toBeInstanceOf(DatabaseSetAsideError)
    expect(err.message).toContain('renaming intersect.db-shm failed (EIO)')
    expect(fs.renames.slice(3)).toEqual([
      `${STAMP}.db-wal>intersect.db-wal`,
      `${STAMP}.db>intersect.db`
    ])
    expect(readdirSync(dir).sort()).toEqual([...SOURCES].sort())
    expect(err.message).toContain(
      'Where the files are now: intersect.db is under its own name; ' +
        'intersect.db-wal is under its own name; intersect.db-shm is under its own name.'
    )
  })

  test('a failed rename with a companion missing reports that file as absent', () => {
    const dir = profile(['intersect.db', 'intersect.db-wal'])
    const fs = recordingFs({ [`intersect.db-wal>${STAMP}.db-wal`]: 'EACCES' })

    const err = thrown(() => setAsideDatabase(dir, NOW, fs))

    expect(err.message).toContain(
      'Where the files are now: intersect.db is under its own name; ' +
        'intersect.db-wal is under its own name; intersect.db-shm does not exist.'
    )
  })

  test('a failed move back stops the rollback, so the database never returns without its WAL', () => {
    const dir = profile()
    const fs = recordingFs({
      [`intersect.db-shm>${STAMP}.db-shm`]: 'EIO',
      [`${STAMP}.db-wal>intersect.db-wal`]: 'EPERM'
    })

    const err = thrown(() => setAsideDatabase(dir, NOW, fs))

    expect(err).toBeInstanceOf(DatabaseSetAsideError)
    // The rollback made no call after its own failure: the database was not moved back.
    expect(fs.renames).toEqual([
      `intersect.db>${STAMP}.db`,
      `intersect.db-wal>${STAMP}.db-wal`,
      `intersect.db-shm>${STAMP}.db-shm`,
      `${STAMP}.db-wal>intersect.db-wal`
    ])
    expect(readdirSync(dir).sort()).toEqual(
      [`${STAMP}.db`, `${STAMP}.db-wal`, 'intersect.db-shm'].sort()
    )
    expect(err.message).toContain('renaming intersect.db-shm failed (EIO)')
    expect(err.message).toContain('moving intersect.db-wal back failed (EPERM)')
    expect(err.message).toContain(`intersect.db is now ${STAMP}.db`)
    expect(err.message).toContain(`intersect.db-wal is now ${STAMP}.db-wal`)
    expect(err.message).toContain('intersect.db-shm is under its own name')
  })
})
