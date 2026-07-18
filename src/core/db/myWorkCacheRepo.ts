import type { DatabaseSync } from 'node:sqlite'
import type { JiraIssue } from '@common/domain'

/** The last successfully fetched Jira board, with the moment it was fetched. */
export interface MyWorkSnapshot {
  issues: JiraIssue[]
  fetchedAt: number
}

export interface MyWorkCacheRepo {
  /** The persisted board snapshot, or null when nothing was ever fetched. */
  get(): MyWorkSnapshot | null
  /** Replace the snapshot with a fresh fetch result. */
  put(snapshot: MyWorkSnapshot): void
}

export function createMyWorkCacheRepo(db: DatabaseSync): MyWorkCacheRepo {
  return {
    get() {
      const row = db
        .prepare(`SELECT issues_json, fetched_at FROM my_work_cache WHERE key = 'board'`)
        .get() as { issues_json: string; fetched_at: number } | undefined
      if (!row) return null
      try {
        return { issues: JSON.parse(row.issues_json) as JiraIssue[], fetchedAt: row.fetched_at }
      } catch {
        return null
      }
    },

    put(snapshot) {
      db.prepare(
        `INSERT INTO my_work_cache (key, issues_json, fetched_at) VALUES ('board', ?, ?)
         ON CONFLICT(key) DO UPDATE SET issues_json = excluded.issues_json, fetched_at = excluded.fetched_at`
      ).run(JSON.stringify(snapshot.issues), snapshot.fetchedAt)
    }
  }
}
