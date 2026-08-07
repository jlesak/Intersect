import type { DatabaseSync } from 'node:sqlite'
import type { PrReviewer, PrRole, PrVote, PullRequest } from '@common/domain'
import type { RepoDeps } from './deps'
import { tx } from './tx'

interface PrRow {
  repository_id: string
  pr_id: number
  project_id: string
  repository_name: string
  title: string
  author_id: string
  author_name: string
  created_at: number
  status: string
  source_ref: string
  target_ref: string
  source_commit: string
  target_commit: string
  url: string
  my_role: string
  /** NULL both when I am not a reviewer and on rows cached before the column existed. */
  my_vote: string | null
  /** NULL both when I am not a reviewer and on rows cached before the column existed. */
  my_reviewer_id: string | null
  reviewers_json: string
  active_thread_count: number
  last_activity_at: number
  synced_at: number
}

function toPr(row: PrRow): PullRequest {
  return {
    prId: row.pr_id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    projectId: row.project_id,
    title: row.title,
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    status: row.status,
    sourceRefName: row.source_ref,
    targetRefName: row.target_ref,
    sourceCommitId: row.source_commit,
    targetCommitId: row.target_commit,
    url: row.url,
    role: row.my_role as PrRole,
    myVote: (row.my_vote as PrVote | null) ?? null,
    myReviewerId: row.my_reviewer_id ?? null,
    reviewers: JSON.parse(row.reviewers_json) as PrReviewer[],
    // Derived from the review watermark by the read path (see reviewWatermark), never stored.
    newChangesSinceMyReview: false,
    activeThreadCount: row.active_thread_count ?? 0,
    lastActivityAt: row.last_activity_at ?? 0
  }
}

/**
 * The `app_state` key carrying when the whole cache was last replaced. Kept beside the cache rather
 * than derived from them, because a sync that legitimately found no pull requests still happened -
 * and an empty inbox reading as "never synced" is a freshness indicator lying about itself.
 */
const SYNCED_AT_KEY = 'pr_cache_synced_at'

export interface PrCacheRepo {
  /** Replace the whole cache with a fresh sync result, in one transaction, stamped with synced_at. */
  replaceAll(prs: PullRequest[]): void
  list(): PullRequest[]
  /**
   * When the cache was last replaced by a sync, or null when no sync has ever completed. Answers
   * how stale the pull-request board is, which only the cache itself can know across restarts.
   */
  getSyncedAt(): number | null
  get(repositoryId: string, prId: number): PullRequest | undefined
  /**
   * Record a vote just cast from Intersect on the cached row, without waiting for a full sync:
   * my vote, the caller-updated reviewers array, and my reviewer entry id (which fills in a row
   * cached before the vote resolved it). A no-op when the PR is not cached.
   */
  updateVote(
    repositoryId: string,
    prId: number,
    vote: PrVote,
    reviewers: PrReviewer[],
    myReviewerId: string
  ): void
}

export function createPrCacheRepo(db: DatabaseSync, deps: RepoDeps): PrCacheRepo {
  return {
    replaceAll(prs) {
      const syncedAt = deps.now()
      tx(db, () => {
        db.exec('DELETE FROM pr_cache')
        const stmt = db.prepare(
          `INSERT INTO pr_cache
             (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
              created_at, status, source_ref, target_ref, source_commit, target_commit, url,
              my_role, my_vote, my_reviewer_id, reviewers_json, active_thread_count,
              last_activity_at, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        for (const pr of prs) {
          stmt.run(
            pr.repositoryId,
            pr.prId,
            pr.projectId,
            pr.repositoryName,
            pr.title,
            pr.authorId,
            pr.authorName,
            pr.createdAt,
            pr.status,
            pr.sourceRefName,
            pr.targetRefName,
            pr.sourceCommitId,
            pr.targetCommitId,
            pr.url,
            pr.role,
            pr.myVote,
            pr.myReviewerId,
            JSON.stringify(pr.reviewers),
            pr.activeThreadCount,
            pr.lastActivityAt,
            syncedAt
          )
        }
        db.prepare(
          `INSERT INTO app_state (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(SYNCED_AT_KEY, String(syncedAt))
      })
    },

    list() {
      const rows = db
        .prepare('SELECT * FROM pr_cache ORDER BY created_at DESC')
        .all() as unknown as PrRow[]
      return rows.map(toPr)
    },

    getSyncedAt() {
      const stamped = db.prepare('SELECT value FROM app_state WHERE key = ?').get(SYNCED_AT_KEY) as
        | { value: string | null }
        | undefined
      const value = stamped?.value === null || stamped?.value === undefined ? null : Number(stamped.value)
      if (value !== null && Number.isFinite(value)) return value
      // A cache filled before the stamp existed still carries the sync time on its rows. MAX over an
      // empty table yields a row whose value is NULL, so a row is no proof of a timestamp.
      const row = db.prepare('SELECT MAX(synced_at) AS t FROM pr_cache').get() as
        | { t: number | null }
        | undefined
      return row?.t ?? null
    },

    get(repositoryId, prId) {
      const row = db
        .prepare('SELECT * FROM pr_cache WHERE repository_id = ? AND pr_id = ?')
        .get(repositoryId, prId) as PrRow | undefined
      return row ? toPr(row) : undefined
    },

    updateVote(repositoryId, prId, vote, reviewers, myReviewerId) {
      db.prepare(
        `UPDATE pr_cache
            SET my_vote = ?, reviewers_json = ?, my_reviewer_id = ?
          WHERE repository_id = ? AND pr_id = ?`
      ).run(vote, JSON.stringify(reviewers), myReviewerId, repositoryId, prId)
    }
  }
}
