import type { DatabaseSync } from 'node:sqlite'
import type { DraftComment, DraftSource, DraftStatus, NewManualDraft } from '@common/domain'
import type { RepoDeps } from './deps'

interface DraftRow {
  id: string
  pr_id: number
  repository_id: string
  file_path: string
  line: number
  side: string
  body: string
  status: string
  source: string
  review_session_id: string | null
  published_thread_id: number | null
  created_at: number
}

function toDraft(row: DraftRow): DraftComment {
  return {
    id: row.id,
    prId: row.pr_id,
    repositoryId: row.repository_id,
    filePath: row.file_path,
    line: row.line,
    side: row.side as DraftComment['side'],
    body: row.body,
    status: row.status as DraftStatus,
    source: row.source as DraftSource,
    reviewSessionId: row.review_session_id,
    publishedThreadId: row.published_thread_id,
    createdAt: row.created_at
  }
}

export interface DraftCommentRepo {
  /** Create a pending draft from the given source (Claude session or a manual diff comment). */
  create(input: NewManualDraft, source: DraftSource, reviewSessionId?: string | null): DraftComment
  /** All non-discarded drafts for a PR, oldest first. */
  listByPr(repositoryId: string, prId: number): DraftComment[]
  get(id: string): DraftComment | undefined
  setBody(id: string, body: string): DraftComment
  setStatus(id: string, status: DraftStatus, publishedThreadId?: number | null): DraftComment
  /**
   * Atomically move a draft into the `publishing` state, but only from a not-yet-published state.
   * Returns true iff this call won the claim - the guard against double-publishing the same comment.
   */
  claimForPublish(id: string): boolean
}

export function createDraftCommentRepo(db: DatabaseSync, deps: RepoDeps): DraftCommentRepo {
  const get = (id: string): DraftComment | undefined => {
    const row = db.prepare('SELECT * FROM draft_comment WHERE id = ?').get(id) as DraftRow | undefined
    return row ? toDraft(row) : undefined
  }

  const mustGet = (id: string): DraftComment => {
    const draft = get(id)
    if (!draft) throw new Error(`Draft comment not found: ${id}`)
    return draft
  }

  return {
    create(input, source, reviewSessionId = null) {
      const id = deps.newId()
      db.prepare(
        `INSERT INTO draft_comment
           (id, pr_id, repository_id, file_path, line, side, body, status, source, review_session_id, published_thread_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        input.prId,
        input.repositoryId,
        input.filePath,
        input.line,
        input.side,
        input.body,
        'pending',
        source,
        reviewSessionId,
        null,
        deps.now()
      )
      return mustGet(id)
    },

    listByPr(repositoryId, prId) {
      const rows = db
        .prepare(
          `SELECT * FROM draft_comment
           WHERE repository_id = ? AND pr_id = ? AND status != 'discarded'
           ORDER BY created_at`
        )
        .all(repositoryId, prId) as unknown as DraftRow[]
      return rows.map(toDraft)
    },

    get,

    setBody(id, body) {
      mustGet(id)
      db.prepare('UPDATE draft_comment SET body = ? WHERE id = ?').run(body, id)
      return mustGet(id)
    },

    setStatus(id, status, publishedThreadId) {
      mustGet(id)
      if (publishedThreadId === undefined) {
        db.prepare('UPDATE draft_comment SET status = ? WHERE id = ?').run(status, id)
      } else {
        db.prepare('UPDATE draft_comment SET status = ?, published_thread_id = ? WHERE id = ?').run(
          status,
          publishedThreadId,
          id
        )
      }
      return mustGet(id)
    },

    claimForPublish(id) {
      const result = db
        .prepare(
          `UPDATE draft_comment SET status = 'publishing'
           WHERE id = ? AND status IN ('pending','approved')`
        )
        .run(id)
      return result.changes === 1
    }
  }
}
