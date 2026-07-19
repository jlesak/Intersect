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
  },
  {
    // Projects (F1): the umbrella entity binding repo folders and external tools into one durable
    // work context. Every existing workspace becomes exactly one project (reusing the workspace id
    // as the project id - the explicit legacy mapping) whose first repository binding is the former
    // workspace folder; the workspace itself lives on as the project's terminal context via
    // `workspaces.project_id`. Deleting a project detaches its workspaces (SET NULL - they fall
    // into the virtual "Other" bucket) and never deletes filesystem folders or remote resources.
    version: 13,
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          sort_order      INTEGER NOT NULL,
          archived        INTEGER NOT NULL DEFAULT 0,
          jira_jql        TEXT,
          jira_board_url  TEXT,
          toggl_project_id INTEGER,
          created_at      INTEGER NOT NULL
        );

        CREATE TABLE project_repo (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          path       TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, path)
        );

        CREATE TABLE project_ado_repo (
          project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          repository_name TEXT NOT NULL,
          PRIMARY KEY (project_id, repository_name)
        );

        ALTER TABLE workspaces ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

        INSERT INTO projects (id, name, sort_order, archived, created_at)
          SELECT id, name, sort_order, 0, created_at FROM workspaces;

        INSERT INTO project_repo (project_id, path, sort_order, created_at)
          SELECT id, folder_path, 0, created_at FROM workspaces;

        UPDATE workspaces SET project_id = id;
      `)
    }
  },
  {
    // Project rail (F1): traceable workspace assignment plus durable manual overrides for
    // external content. Overrides cascade away with their project so items fall back to
    // inference instead of pointing at a ghost.
    version: 14,
    up(db) {
      db.exec(`
        ALTER TABLE workspaces ADD COLUMN project_source TEXT NOT NULL DEFAULT 'auto'
          CHECK (project_source IN ('auto','manual'));

        CREATE TABLE project_overrides (
          kind       TEXT NOT NULL CHECK (kind IN ('pr','jira')),
          ext_key    TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (kind, ext_key)
        );
      `)
    }
  },
  {
    // Resizable terminal layouts: each project remembers its own pane shares per layout type.
    // `project_key` is a project id or the literal 'other' (the virtual bucket for unassigned
    // workspaces), deliberately without a foreign key so the Other bucket persists too; the
    // owning project's rows are cleaned up by the project-removal handler instead. `shares` is
    // a JSON share shape validated on every read, so a corrupt row degrades to equal shares
    // rather than blocking startup.
    version: 15,
    up(db) {
      db.exec(`
        CREATE TABLE project_terminal_layouts (
          project_key TEXT NOT NULL,
          layout      TEXT NOT NULL,
          shares      TEXT NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_key, layout)
        );
      `)
    }
  },
  {
    // Hook lifecycle: every authenticated hook event a managed Claude session posts, kept
    // raw for diagnostics and future digests. `session_id` is the Intersect instance id the
    // helper tagged the POST with (`workspaceId:tabId`), not Claude's own session UUID.
    // Local-only data with real retention pruning - rows never leave the machine.
    version: 16,
    up(db) {
      db.exec(`
        CREATE TABLE hook_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   TEXT NOT NULL,
          event_name   TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          received_at  INTEGER NOT NULL
        );

        CREATE INDEX idx_hook_events_session ON hook_events(session_id, received_at);
      `)
    }
  },
  {
    // Direct Jira sync: the per-source issue read model replacing the single-row board snapshot.
    // Each source ('global', or 'project:<id>' for a project's own JQL/board query) keeps one row
    // per issue - a stable identity for session <-> ticket <-> project links - plus one sync-state
    // row carrying the last successful fetch time and the last error. Issues missing from the
    // latest fetch are marked absent, never deleted. The legacy global board seeds the new model
    // so nothing already cached is lost, then the legacy table is dropped.
    version: 17,
    up(db) {
      db.exec(`
        CREATE TABLE jira_issue_cache (
          source_key TEXT NOT NULL,
          issue_key  TEXT NOT NULL,
          data_json  TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          absent     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source_key, issue_key)
        );

        CREATE TABLE jira_sync_state (
          source_key    TEXT PRIMARY KEY,
          fetched_at    INTEGER,
          partial       INTEGER NOT NULL DEFAULT 0,
          error_kind    TEXT,
          error_message TEXT
        );
      `)

      const legacy = db
        .prepare(`SELECT issues_json, fetched_at FROM my_work_cache WHERE key = 'board'`)
        .get() as { issues_json: string; fetched_at: number } | undefined
      if (legacy) {
        try {
          const issues = JSON.parse(legacy.issues_json) as Array<{
            key: string
            url: string
            summary: string
            column: string
            priority: string | null
            updatedAt: number
          }>
          const insert = db.prepare(
            `INSERT OR REPLACE INTO jira_issue_cache (source_key, issue_key, data_json, fetched_at, absent)
             VALUES ('global', ?, ?, ?, 0)`
          )
          for (const issue of issues) {
            if (!issue || typeof issue.key !== 'string' || issue.key === '') continue
            // The legacy snapshot never carried the raw remote fields; seed them as unknown.
            const snapshot = {
              ...issue,
              description: null,
              rawStatus: '',
              rawPriority: null,
              assignee: null,
              epicKey: null,
              epicSummary: null,
              estimateSeconds: null,
              components: [],
              fetchedAt: legacy.fetched_at,
              absent: false
            }
            insert.run(issue.key, JSON.stringify(snapshot), legacy.fetched_at)
          }
          db.prepare(
            `INSERT INTO jira_sync_state (source_key, fetched_at, partial) VALUES ('global', ?, 0)`
          ).run(legacy.fetched_at)
        } catch {
          // An unreadable legacy snapshot seeds nothing; the first direct fetch rebuilds it.
        }
      }

      db.exec('DROP TABLE my_work_cache;')
    }
  },
  {
    // Primary work items: at most one durable polymorphic work-item link per session (the tab-id
    // primary key IS the invariant), carrying the item's display snapshot so it stays readable
    // after the remote item disappears. The append-only event table audits every assign/change/
    // clear and deliberately has no tab foreign key - history survives tab deletion. Existing
    // tabs simply have no ref row and stay manually assignable.
    version: 18,
    up(db) {
      db.exec(`
        CREATE TABLE work_item_refs (
          tab_id         TEXT PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
          source         TEXT NOT NULL CHECK (source IN ('jira','todo','ado-pr')),
          external_key   TEXT NOT NULL,
          project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
          snapshot_key   TEXT NOT NULL,
          snapshot_title TEXT NOT NULL,
          snapshot_type  TEXT NOT NULL,
          assigned_at    INTEGER NOT NULL
        );

        CREATE TABLE work_item_ref_events (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          tab_id         TEXT NOT NULL,
          action         TEXT NOT NULL CHECK (action IN ('assign','change','clear')),
          source         TEXT,
          external_key   TEXT,
          snapshot_key   TEXT,
          snapshot_title TEXT,
          at             INTEGER NOT NULL
        );

        CREATE INDEX idx_work_item_ref_events_tab ON work_item_ref_events(tab_id, at);
      `)
    }
  },
  {
    // Agent runtime evidence: measured agent runtime, kept strictly separate from human worklogs
    // and never uploaded. One row per session per local day (the composite primary key is the
    // idempotency guard - a recompute upserts in place). `source` distinguishes primary hook
    // pings from the coarse JSONL transcript fallback; `confidence` labels how trustworthy the
    // figure is. `project_id` and the optional work-item columns carry attribution, all nullable
    // so unknown context simply stays unassigned. `external_id` is the stable idempotent key.
    // This table is NOT a Toggl outbox and holds nothing that is confirmed human time.
    version: 19,
    up(db) {
      db.exec(`
        CREATE TABLE agent_runtime_evidence (
          session_id       TEXT NOT NULL,
          local_date       TEXT NOT NULL,
          minutes          INTEGER NOT NULL,
          source           TEXT NOT NULL CHECK (source IN ('hook','jsonl')),
          confidence       TEXT NOT NULL CHECK (confidence IN ('high','low')),
          project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
          work_item_source TEXT,
          work_item_key    TEXT,
          external_id      TEXT NOT NULL,
          computed_at      INTEGER NOT NULL,
          PRIMARY KEY (session_id, local_date)
        );

        CREATE INDEX idx_agent_runtime_date ON agent_runtime_evidence(local_date);
        CREATE INDEX idx_agent_runtime_project ON agent_runtime_evidence(project_id, local_date);
      `)
    }
  },
  {
    // Suspend-on-quit / resume-on-launch: a claude tab carries the suspend lifecycle inline on its
    // row (`session_status` nullable: 'suspended' | 'resuming' | 'resume-failed' | NULL = normal),
    // written before the destructive shutdown and cleared on a successful respawn. The append-only
    // event table durably audits every suspend/resume/resume-failed with its reason; it has no tab
    // foreign key on purpose - the history outlives the tab.
    version: 20,
    up(db) {
      db.exec(`
        ALTER TABLE tabs ADD COLUMN session_status TEXT;
        ALTER TABLE tabs ADD COLUMN suspend_reason TEXT;
        ALTER TABLE tabs ADD COLUMN suspended_at INTEGER;

        CREATE TABLE session_lifecycle_events (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          tab_id  TEXT NOT NULL,
          action  TEXT NOT NULL CHECK (action IN ('suspend','resume','resume-failed')),
          reason  TEXT,
          at      INTEGER NOT NULL
        );

        CREATE INDEX idx_session_lifecycle_events_tab ON session_lifecycle_events(tab_id, at);
      `)
    }
  }
]

/** The schema version a freshly-migrated database ends at. */
export const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Apply every migration newer than the database's current `user_version`, each inside its own
 * transaction so a failure rolls back that migration (including its `user_version` bump).
 * Safe to run on every launch; already-applied migrations are skipped. `upTo` stops after the
 * given version - it exists so upgrade-path tests can build a database at any historic schema
 * version; production callers omit it.
 */
export function runMigrations(db: DatabaseSync, upTo: number = Infinity): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > upTo) continue
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
