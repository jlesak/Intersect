import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations'
import type { RepoDeps } from './deps'

/** A migrated in-memory database for repository tests (no WAL, no file, no rebuild). */
export function makeTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  runMigrations(db)
  return db
}

/** Deterministic clock + id generator so repo tests can assert exact ids and ordering. */
export function makeTestDeps(): RepoDeps {
  let idCounter = 0
  let clock = 1000
  return {
    newId: () => `id-${++idCounter}`,
    now: () => ++clock
  }
}
