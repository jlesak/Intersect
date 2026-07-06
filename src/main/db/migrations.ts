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
  },
  {
    // PR Review Inbox (slice 2): cached PRs, local draft comments, and review-session bookkeeping.
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE pr_cache (
          repository_id   TEXT NOT NULL,
          pr_id           INTEGER NOT NULL,
          project_id      TEXT NOT NULL,
          repository_name TEXT NOT NULL,
          title           TEXT NOT NULL,
          author_id       TEXT NOT NULL,
          author_name     TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          status          TEXT NOT NULL,
          source_ref      TEXT NOT NULL,
          target_ref      TEXT NOT NULL,
          source_commit   TEXT NOT NULL,
          target_commit   TEXT NOT NULL,
          url             TEXT NOT NULL,
          my_role         TEXT NOT NULL CHECK (my_role IN ('author','reviewer')),
          reviewers_json  TEXT NOT NULL,
          synced_at       INTEGER NOT NULL,
          PRIMARY KEY (repository_id, pr_id)
        );

        CREATE TABLE draft_comment (
          id                  TEXT PRIMARY KEY,
          pr_id               INTEGER NOT NULL,
          repository_id       TEXT NOT NULL,
          file_path           TEXT NOT NULL,
          line                INTEGER NOT NULL,
          side                TEXT NOT NULL CHECK (side IN ('left','right')),
          body                TEXT NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('pending','approved','publishing','published','discarded')),
          source              TEXT NOT NULL CHECK (source IN ('claude','manual')),
          review_session_id   TEXT,
          published_thread_id INTEGER,
          created_at          INTEGER NOT NULL
        );

        CREATE INDEX idx_draft_pr ON draft_comment(repository_id, pr_id);

        CREATE TABLE review_session (
          id            TEXT PRIMARY KEY,
          pr_id         INTEGER NOT NULL,
          repository_id TEXT NOT NULL,
          repo_dir      TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          status        TEXT NOT NULL CHECK (status IN ('running','completed','failed','cleaned')),
          created_at    INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // Session Search (slice 4): a tab can resume a past Claude Code session via `claude --resume`.
    // The resumed session id is persisted so the conversation survives an app restart.
    version: 3,
    up(db) {
      db.exec(`ALTER TABLE tabs ADD COLUMN resume_session_id TEXT;`)
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
