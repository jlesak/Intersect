import type { DatabaseSync } from 'node:sqlite'
import type { JiraBoardSnapshot, JiraIssueSnapshot, JiraSyncError } from '@common/domain'
import { tx } from './tx'

/**
 * The per-source Jira read model: one row per issue keyed (source, issue key) - a stable
 * identity for session <-> ticket <-> project links - plus one sync-state row per source. A
 * successful sync upserts the fetched issues and marks everything the fetch no longer returned
 * as absent (never deleting rows); a failed sync only records the error, so the last-good board
 * survives auth expiry, network trouble, and server failures alike.
 */
export interface JiraCacheRepo {
  /** The cached board envelope, or null when the source was never synced (not even a failure). */
  getBoard(sourceKey: string): JiraBoardSnapshot | null
  /** Land one successful fetch: upsert issues, mark the missing ones absent, clear the error. */
  putSuccess(sourceKey: string, issues: JiraIssueSnapshot[], fetchedAt: number, partial: boolean): void
  /** Land one failed fetch: record the error, keeping the issues and last-good fetch time. */
  putError(sourceKey: string, error: JiraSyncError): void
  /**
   * Whether the issue is known to any source's cache: 'present' when at least one source still
   * returns it, 'absent' when every caching source has flagged it gone, 'unknown' when no cache
   * has ever seen it. Feeds the work-item liveness computation across all sources at once.
   */
  issuePresence(issueKey: string): 'present' | 'absent' | 'unknown'
  /**
   * Every cached issue across all sources, deduplicated by issue key (a present row beats an
   * absent one, then the freshest fetch wins) - the corpus the work-item picker searches.
   */
  listAllIssues(): JiraIssueSnapshot[]
}

interface StateRow {
  fetched_at: number | null
  partial: number
  error_kind: string | null
  error_message: string | null
}

export function createJiraCacheRepo(db: DatabaseSync): JiraCacheRepo {
  return {
    getBoard(sourceKey) {
      const state = db
        .prepare(
          `SELECT fetched_at, partial, error_kind, error_message
           FROM jira_sync_state WHERE source_key = ?`
        )
        .get(sourceKey) as StateRow | undefined
      if (!state) return null

      const rows = db
        .prepare(`SELECT data_json, absent FROM jira_issue_cache WHERE source_key = ?`)
        .all(sourceKey) as { data_json: string; absent: number }[]
      const issues: JiraIssueSnapshot[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data_json) as JiraIssueSnapshot
          issues.push({ ...parsed, absent: row.absent === 1 })
        } catch {
          // A corrupt row degrades to a missing issue rather than a broken board.
        }
      }
      issues.sort((a, b) => b.updatedAt - a.updatedAt)

      return {
        sourceKey,
        issues,
        fetchedAt: state.fetched_at,
        partial: state.partial === 1,
        error:
          state.error_kind !== null
            ? {
                kind: state.error_kind as JiraSyncError['kind'],
                message: state.error_message ?? ''
              }
            : null
      }
    },

    putSuccess(sourceKey, issues, fetchedAt, partial) {
      tx(db, () => {
        // Two passes keep the absent marking exact without dynamic IN lists: everything is
        // flagged absent first, then each fetched issue is upserted back to present.
        db.prepare(`UPDATE jira_issue_cache SET absent = 1 WHERE source_key = ?`).run(sourceKey)
        const upsert = db.prepare(
          `INSERT INTO jira_issue_cache (source_key, issue_key, data_json, fetched_at, absent)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(source_key, issue_key) DO UPDATE SET
             data_json = excluded.data_json, fetched_at = excluded.fetched_at, absent = 0`
        )
        for (const issue of issues) {
          upsert.run(sourceKey, issue.key, JSON.stringify(issue), fetchedAt)
        }
        db.prepare(
          `INSERT INTO jira_sync_state (source_key, fetched_at, partial, error_kind, error_message)
           VALUES (?, ?, ?, NULL, NULL)
           ON CONFLICT(source_key) DO UPDATE SET
             fetched_at = excluded.fetched_at, partial = excluded.partial,
             error_kind = NULL, error_message = NULL`
        ).run(sourceKey, fetchedAt, partial ? 1 : 0)
      })
    },

    issuePresence(issueKey) {
      const rows = db
        .prepare('SELECT absent FROM jira_issue_cache WHERE issue_key = ?')
        .all(issueKey) as { absent: number }[]
      if (rows.length === 0) return 'unknown'
      return rows.some((row) => row.absent === 0) ? 'present' : 'absent'
    },

    listAllIssues() {
      const rows = db
        .prepare('SELECT data_json, absent, fetched_at FROM jira_issue_cache')
        .all() as { data_json: string; absent: number; fetched_at: number }[]
      const byKey = new Map<string, { issue: JiraIssueSnapshot; fetchedAt: number }>()
      for (const row of rows) {
        let parsed: JiraIssueSnapshot
        try {
          parsed = JSON.parse(row.data_json) as JiraIssueSnapshot
        } catch {
          // A corrupt row degrades to a missing issue rather than a broken listing.
          continue
        }
        const issue = { ...parsed, absent: row.absent === 1 }
        const existing = byKey.get(issue.key)
        const wins =
          !existing ||
          (existing.issue.absent && !issue.absent) ||
          (existing.issue.absent === issue.absent && row.fetched_at > existing.fetchedAt)
        if (wins) byKey.set(issue.key, { issue, fetchedAt: row.fetched_at })
      }
      return [...byKey.values()]
        .map((entry) => entry.issue)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    putError(sourceKey, error) {
      db.prepare(
        `INSERT INTO jira_sync_state (source_key, fetched_at, partial, error_kind, error_message)
         VALUES (?, NULL, 0, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           error_kind = excluded.error_kind, error_message = excluded.error_message`
      ).run(sourceKey, error.kind, error.message)
    }
  }
}
