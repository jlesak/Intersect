import type { DatabaseSync } from 'node:sqlite'
import type { ReviewSession, ReviewStatus } from '@common/domain'
import type { RepoDeps } from './deps'

interface ReviewRow {
  id: string
  pr_id: number
  repository_id: string
  repo_dir: string
  worktree_path: string
  status: string
  created_at: number
}

function toSession(row: ReviewRow): ReviewSession {
  return {
    id: row.id,
    prId: row.pr_id,
    repositoryId: row.repository_id,
    repoDir: row.repo_dir,
    worktreePath: row.worktree_path,
    status: row.status as ReviewStatus,
    createdAt: row.created_at
  }
}

export type NewReviewSession = Pick<
  ReviewSession,
  'prId' | 'repositoryId' | 'repoDir' | 'worktreePath'
>

export interface ReviewSessionRepo {
  create(input: NewReviewSession): ReviewSession
  /** The single running session, if any (enforces the one-live-review invariant). */
  getActive(): ReviewSession | undefined
  get(id: string): ReviewSession | undefined
  setStatus(id: string, status: ReviewStatus): ReviewSession
  remove(id: string): void
}

export function createReviewSessionRepo(db: DatabaseSync, deps: RepoDeps): ReviewSessionRepo {
  const get = (id: string): ReviewSession | undefined => {
    const row = db.prepare('SELECT * FROM review_session WHERE id = ?').get(id) as
      | ReviewRow
      | undefined
    return row ? toSession(row) : undefined
  }

  const mustGet = (id: string): ReviewSession => {
    const session = get(id)
    if (!session) throw new Error(`Review session not found: ${id}`)
    return session
  }

  return {
    create(input) {
      const id = deps.newId()
      db.prepare(
        `INSERT INTO review_session (id, pr_id, repository_id, repo_dir, worktree_path, status, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(id, input.prId, input.repositoryId, input.repoDir, input.worktreePath, 'running', deps.now())
      return mustGet(id)
    },

    getActive() {
      const row = db
        .prepare("SELECT * FROM review_session WHERE status = 'running' ORDER BY created_at LIMIT 1")
        .get() as ReviewRow | undefined
      return row ? toSession(row) : undefined
    },

    get,

    setStatus(id, status) {
      mustGet(id)
      db.prepare('UPDATE review_session SET status = ? WHERE id = ?').run(status, id)
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM review_session WHERE id = ?').run(id)
    }
  }
}
