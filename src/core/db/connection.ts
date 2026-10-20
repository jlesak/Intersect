import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MigrationError, runMigrations } from './migrations'

/** The database file under the user-data directory. Messages name it by this, never by path. */
const DB_FILE = 'intersect.db'

/** The database and its WAL companions, in the order they are set aside. */
const DB_SUFFIXES = ['', '-wal', '-shm'] as const

/**
 * The database could not be opened, configured or migrated. Every boot runs the same step against
 * the same file, so this failure repeats until the file changes - which is what lets the failure
 * card offer to set the database aside. A migration failure keeps its own message, which names the
 * migration; anything else is prefixed so the card reads as a database failure.
 */
export class DatabaseStartupError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(cause instanceof MigrationError ? detail : `could not open the database: ${detail}`, {
      cause
    })
    this.name = 'DatabaseStartupError'
  }
}

/**
 * Open (creating if needed) the app's SQLite database under the given user-data directory,
 * enable WAL + foreign keys, and bring the schema up to date. WAL persists in the file header;
 * foreign_keys is per-connection and re-asserted on every open. Migrations must not touch WAL.
 *
 * Any failure throws a `DatabaseStartupError` and closes the handle first. A handle left open would,
 * once collected, checkpoint and delete `intersect.db-wal` by name - after a set-aside, that is the
 * fresh database's WAL.
 */
export function openDatabase(userDataDir: string): DatabaseSync {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(join(userDataDir, DB_FILE))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
    return db
  } catch (err) {
    closeQuietly(db)
    throw new DatabaseStartupError(err)
  }
}

/** Close a handle on a failure path, where a second error must not replace the first. */
export function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close()
  } catch {
    // already closed, or never opened
  }
}

/**
 * Setting the database aside failed. Its message names the rename that failed and, for each of the
 * three files, where it is now, so a user can finish or undo the move by hand.
 */
export class DatabaseSetAsideError extends Error {
  constructor(message: string) {
    super(`could not set the database aside: ${message}`)
    this.name = 'DatabaseSetAsideError'
  }
}

/** The filesystem calls a set-aside makes, injectable so tests can fail a chosen rename. */
export interface SetAsideFs {
  exists(path: string): boolean
  rename(from: string, to: string): void
}

const nodeFs: SetAsideFs = {
  exists: (path) => existsSync(path),
  rename: (from, to) => renameSync(from, to)
}

/** `YYYYMMDD-HHMMSS` in local time, the stamp that keeps each set-aside apart. */
function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** The fs error code when there is one, since that is what tells a user what went wrong. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.message : String(err)
}

/**
 * Rename the database and the companion files that exist to `intersect-set-aside-<stamp>.db` plus
 * the same suffix, in the same folder, so the next open starts on an empty database. The shared base
 * name keeps the set-aside files a set SQLite can open together.
 *
 * Nothing is overwritten and nothing is deleted: every target is checked free before the first
 * rename. A database must never be paired with another one's WAL, so a failed rename moves the files
 * already renamed back in reverse order, and the rollback stops at its own first failure rather than
 * move the database back without its WAL. Every failure throws a `DatabaseSetAsideError`.
 */
export function setAsideDatabase(
  userDataDir: string,
  now: Date,
  fs: SetAsideFs = nodeFs
): { from: string[]; to: string[] } {
  const base = `intersect-set-aside-${stamp(now)}.db`
  const files = DB_SUFFIXES.map((suffix) => ({
    name: `${DB_FILE}${suffix}`,
    target: `${base}${suffix}`,
    exists: fs.exists(join(userDataDir, `${DB_FILE}${suffix}`)),
    setAside: false
  }))
  const path = (name: string): string => join(userDataDir, name)

  const whereNow = (): string =>
    files
      .map((f) =>
        !f.exists
          ? `${f.name} does not exist`
          : f.setAside
            ? `${f.name} is now ${f.target}`
            : `${f.name} is under its own name`
      )
      .join('; ')

  const taken = files.find((f) => fs.exists(path(f.target)))
  if (taken) {
    throw new DatabaseSetAsideError(
      `${taken.target} already exists, so nothing was renamed. Where the files are: ${whereNow()}.`
    )
  }

  const present = files.filter((f) => f.exists)
  for (const [index, file] of present.entries()) {
    try {
      fs.rename(path(file.name), path(file.target))
      file.setAside = true
    } catch (err) {
      let failure = `renaming ${file.name} failed (${errorCode(err)})`
      for (const done of present.slice(0, index).reverse()) {
        try {
          fs.rename(path(done.target), path(done.name))
          done.setAside = false
        } catch (rollbackErr) {
          failure += `, and moving ${done.name} back failed (${errorCode(rollbackErr)})`
          break
        }
      }
      throw new DatabaseSetAsideError(`${failure}. Where the files are now: ${whereNow()}.`)
    }
  }

  return { from: present.map((f) => f.name), to: present.map((f) => f.target) }
}
