import type { DatabaseSync } from 'node:sqlite'

let savepointCounter = 0

/**
 * Run `fn` inside a SQLite transaction. Commits on success and returns its value; rolls back
 * everything (and rethrows) if it throws. node:sqlite's DatabaseSync has no `.transaction()`
 * helper, so this is the single place BEGIN/COMMIT/ROLLBACK is expressed.
 *
 * Nests: a tx() inside a running transaction becomes a savepoint, so a repo that wraps its own
 * writes can still be composed into a larger caller-owned transaction.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp${++savepointCounter}`
    db.exec(`SAVEPOINT ${name}`)
    try {
      const result = fn()
      db.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
      throw err
    }
  }

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
