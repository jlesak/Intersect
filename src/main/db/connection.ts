import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations'

/**
 * Open (creating if needed) the app's SQLite database under the given user-data directory,
 * enable WAL + foreign keys, and bring the schema up to date. WAL persists in the file header;
 * foreign_keys is per-connection and re-asserted on every open. Migrations must not touch WAL.
 */
export function openDatabase(userDataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(userDataDir, 'intersect.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}
