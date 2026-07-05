import type { DatabaseSync } from 'node:sqlite'

/**
 * A single forward migration. `up` receives a database handle and must only run statements
 * that are transactional in SQLite (DDL and `PRAGMA user_version` are; `PRAGMA journal_mode`
 * is NOT and must never appear here - it lives in openDatabase for the on-disk connection).
 */
export interface Migration {
  version: number
  up(db: DatabaseSync): void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE workspaces (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          folder_path   TEXT NOT NULL,
          layout        TEXT NOT NULL DEFAULT 'single',
          active_tab_id TEXT,
          sort_order    INTEGER NOT NULL,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE tabs (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title        TEXT NOT NULL,
          preset       TEXT NOT NULL CHECK (preset IN ('shell','claude')),
          pane_slot    INTEGER,
          sort_order   INTEGER NOT NULL,
          created_at   INTEGER NOT NULL
        );

        CREATE INDEX idx_tabs_workspace ON tabs(workspace_id);

        CREATE TABLE app_state (
          key   TEXT PRIMARY KEY,
          value TEXT
        );
      `)
    }
  }
]

/** The schema version a freshly-migrated database ends at. */
export const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Apply every migration newer than the database's current `user_version`, each inside its own
 * transaction so a failure rolls back that migration (including its `user_version` bump).
 * Safe to run on every launch; already-applied migrations are skipped.
 */
export function runMigrations(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      // PRAGMA cannot bind parameters; version is a program-controlled integer, never user input.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
