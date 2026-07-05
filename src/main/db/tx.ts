import type { DatabaseSync } from 'node:sqlite'

/**
 * Run `fn` inside a SQLite transaction. Commits on success and returns its value; rolls back
 * everything (and rethrows) if it throws. node:sqlite's DatabaseSync has no `.transaction()`
 * helper, so this is the single place BEGIN/COMMIT/ROLLBACK is expressed.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
