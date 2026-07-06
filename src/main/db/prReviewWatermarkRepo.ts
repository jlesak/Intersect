import type { DatabaseSync } from 'node:sqlite'
import type { RepoDeps } from './deps'

/**
 * One review watermark: the source commit a PR pointed at when I last voted on it. The PR moving
 * past this commit is what the My Work radar shows as "new changes since my review".
 */
export interface ReviewWatermark {
  repositoryId: string
  prId: number
  votedCommitId: string
  updatedAt: number
}

/** The `${repositoryId}:${prId}` pair a watermark (and a cached PR) is keyed by. */
export interface WatermarkKey {
  repositoryId: string
  prId: number
}

export interface PrReviewWatermarkRepo {
  get(repositoryId: string, prId: number): ReviewWatermark | undefined
  /** Insert the watermark, or move an existing one to the given commit. */
  upsert(repositoryId: string, prId: number, votedCommitId: string): void
  delete(repositoryId: string, prId: number): void
  /** Drop watermarks whose PR is absent from the latest sync (merged, abandoned, unassigned). */
  prune(present: WatermarkKey[]): void
}

interface WatermarkRow {
  repository_id: string
  pr_id: number
  voted_commit_id: string
  updated_at: number
}

export function createPrReviewWatermarkRepo(db: DatabaseSync, deps: RepoDeps): PrReviewWatermarkRepo {
  return {
    get(repositoryId, prId) {
      const row = db
        .prepare('SELECT * FROM pr_review_watermark WHERE repository_id = ? AND pr_id = ?')
        .get(repositoryId, prId) as WatermarkRow | undefined
      if (!row) return undefined
      return {
        repositoryId: row.repository_id,
        prId: row.pr_id,
        votedCommitId: row.voted_commit_id,
        updatedAt: row.updated_at
      }
    },

    upsert(repositoryId, prId, votedCommitId) {
      db.prepare(
        `INSERT INTO pr_review_watermark (repository_id, pr_id, voted_commit_id, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(repository_id, pr_id)
         DO UPDATE SET voted_commit_id = excluded.voted_commit_id, updated_at = excluded.updated_at`
      ).run(repositoryId, prId, votedCommitId, deps.now())
    },

    delete(repositoryId, prId) {
      db.prepare('DELETE FROM pr_review_watermark WHERE repository_id = ? AND pr_id = ?').run(
        repositoryId,
        prId
      )
    },

    prune(present) {
      const keep = new Set(present.map((k) => `${k.repositoryId}:${k.prId}`))
      const rows = db
        .prepare('SELECT repository_id, pr_id FROM pr_review_watermark')
        .all() as unknown as Array<Pick<WatermarkRow, 'repository_id' | 'pr_id'>>
      const del = db.prepare('DELETE FROM pr_review_watermark WHERE repository_id = ? AND pr_id = ?')
      for (const row of rows) {
        if (!keep.has(`${row.repository_id}:${row.pr_id}`)) del.run(row.repository_id, row.pr_id)
      }
    }
  }
}
