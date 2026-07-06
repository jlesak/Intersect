import type { DatabaseSync } from 'node:sqlite'
import type { PrReviewer, PrRole, PullRequest } from '@common/domain'
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
  reviewers_json: string
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
    reviewers: JSON.parse(row.reviewers_json) as PrReviewer[]
  }
}

export interface PrCacheRepo {
  /** Replace the whole cache with a fresh sync result, in one transaction, stamped with synced_at. */
  replaceAll(prs: PullRequest[]): void
  list(): PullRequest[]
  get(repositoryId: string, prId: number): PullRequest | undefined
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
              my_role, reviewers_json, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
            JSON.stringify(pr.reviewers),
            syncedAt
          )
        }
      })
    },

    list() {
      const rows = db
        .prepare('SELECT * FROM pr_cache ORDER BY created_at DESC')
        .all() as unknown as PrRow[]
      return rows.map(toPr)
    },

    get(repositoryId, prId) {
      const row = db
        .prepare('SELECT * FROM pr_cache WHERE repository_id = ? AND pr_id = ?')
        .get(repositoryId, prId) as PrRow | undefined
      return row ? toPr(row) : undefined
    }
  }
}
