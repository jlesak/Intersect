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
  },
  {
    // My Work: the last successfully fetched Jira board, so the section is useful immediately on
    // boot while a fresh fetch runs in the background. A single-row snapshot, replaced whole.
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE my_work_cache (
          key         TEXT PRIMARY KEY CHECK (key = 'board'),
          issues_json TEXT NOT NULL,
          fetched_at  INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // My Work PR radar: cache my own vote per PR, and record per reviewed PR the source commit it
    // pointed at when I last voted. The PR drifting past that watermark is what the radar surfaces
    // as "new changes since my review".
    version: 5,
    up(db) {
      db.exec(`
        ALTER TABLE pr_cache ADD COLUMN my_vote TEXT;

        CREATE TABLE pr_review_watermark (
          repository_id   TEXT NOT NULL,
          pr_id           INTEGER NOT NULL,
          voted_commit_id TEXT NOT NULL,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (repository_id, pr_id)
        );
      `)
    }
  },
  {
    // Time Tracking: the weekly worklog board's two writable stores. `time_entry_manual` holds
    // worklogs the user typed in (`day` is the local calendar day as `yyyy-mm-dd`; a null
    // `issue_key` is deliberate unattributed time, e.g. a meeting). `time_entry_override` carries
    // the user's edits to auto entries derived from Claude Code sessions: a row snapshots BOTH
    // editable fields, so a cleared issue key needs no sentinel, and its `deleted` tombstone keeps
    // a removed auto card from resurrecting on the next session re-scan.
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE time_entry_manual (
          id          TEXT PRIMARY KEY,
          day         TEXT NOT NULL,
          description TEXT NOT NULL,
          issue_key   TEXT,
          duration_ms INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );

        CREATE INDEX idx_time_entry_manual_day ON time_entry_manual(day);

        CREATE TABLE time_entry_override (
          session_id  TEXT PRIMARY KEY,
          issue_key   TEXT,
          duration_ms INTEGER NOT NULL,
          deleted     INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // TODO list: a flat personal task list, independent of workspaces and Jira. `due_day` is the
    // optional local calendar day (`yyyy-mm-dd`) the task is due; `sort_order` is the manual
    // position within the open list. A non-null `done_at` (epoch ms) means the task is done and
    // doubles as the Done section's ordering key (most recently completed first).
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE todo_task (
          id         TEXT PRIMARY KEY,
          text       TEXT NOT NULL,
          due_day    TEXT,
          sort_order INTEGER NOT NULL,
          done_at    INTEGER,
          created_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // 1:1 workflows: the persistent run history. Result columns are per type - a done 'process'
    // run fills notion_url / slack_draft_created / slack_channel_link, a done 'prep' run fills
    // result_markdown, a failed run fills error. `finished_at` stays NULL while the run lives.
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE oto_run (
          id                  TEXT PRIMARY KEY,
          type                TEXT NOT NULL CHECK (type IN ('process','prep')),
          person              TEXT NOT NULL,
          vtt_path            TEXT,
          status              TEXT NOT NULL CHECK (status IN ('running','done','failed')),
          notion_url          TEXT,
          slack_draft_created INTEGER,
          slack_channel_link  TEXT,
          result_markdown     TEXT,
          error               TEXT,
          created_at          INTEGER NOT NULL,
          finished_at         INTEGER
        );

        CREATE INDEX idx_oto_run_created ON oto_run(created_at);
      `)
    }
  },
  {
    // PR voting: remember which reviewer entry on a cached PR is mine, so casting a vote can
    // address the PR's reviewer resource directly instead of re-resolving my identity. NULL when
    // I am not among the reviewers, and on rows cached before the column existed.
    version: 9,
    up(db) {
      db.exec(`ALTER TABLE pr_cache ADD COLUMN my_reviewer_id TEXT;`)
    }
  },
  {
    // Todoist-style TODO list: priority (1 = most urgent, defaulting to 4 = none) replaces manual
    // drag-and-drop ordering, and description gives a task room for detail beyond its title.
    version: 10,
    up(db) {
      db.exec(`
        ALTER TABLE todo_task ADD COLUMN priority INTEGER NOT NULL DEFAULT 4;
        ALTER TABLE todo_task ADD COLUMN description TEXT NOT NULL DEFAULT '';
      `)
    }
  },
  {
    // PR board: unresolved comment threads counted at sync time, so the author-side "needs my
    // action" signal is available without re-fetching every PR's threads on each read.
    version: 11,
    up(db) {
      db.exec(`ALTER TABLE pr_cache ADD COLUMN active_thread_count INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    // Restore manual TODO ordering. Seed it exactly once from the priority-era order users saw,
    // with stable fallbacks for malformed legacy rows that happen to share a sort_order.
    version: 12,
    up(db) {
      db.exec(`
        WITH ordered AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   ORDER BY priority ASC,
                            due_day IS NULL,
                            due_day ASC,
                            sort_order ASC,
                            created_at ASC,
                            id ASC
                 ) - 1 AS manual_order
          FROM todo_task
          WHERE done_at IS NULL
        )
        UPDATE todo_task
        SET sort_order = (SELECT manual_order FROM ordered WHERE ordered.id = todo_task.id)
        WHERE done_at IS NULL;
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
