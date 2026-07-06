import type { CommentSide, DraftComment } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'

/**
 * The context main holds for the single active review session. Draft messages arriving over the
 * socket are anchored to THIS pr/repo/session - the untrusted review session never supplies them,
 * so it cannot record a draft against a different PR.
 */
export interface DraftContext {
  prId: number
  repositoryId: string
  reviewSessionId: string
}

/** The payload the draft MCP server sends over the socket for each record_draft_comment call. */
export interface DraftPayload {
  sessionId: string
  filePath: string
  line: number
  side: string
  body: string
}

/** Parse one newline-delimited JSON draft message; throws on malformed input. */
export function parseDraftPayload(raw: string): DraftPayload {
  const obj = JSON.parse(raw) as Record<string, unknown>
  return {
    sessionId: String(obj.sessionId ?? ''),
    filePath: String(obj.filePath ?? ''),
    line: Number(obj.line),
    side: String(obj.side ?? ''),
    body: String(obj.body ?? '')
  }
}

/**
 * Validate and persist a draft recorded by the review session. Anchors it to the trusted context
 * (pr/repo/session), forces a sane side, and rejects empty/invalid anchors. Pure over the repo, so
 * it is unit-testable against an in-memory database.
 */
export function handleDraftMessage(
  repo: DraftCommentRepo,
  ctx: DraftContext,
  payload: DraftPayload
): DraftComment {
  const filePath = payload.filePath.trim()
  if (!filePath) throw new Error('Draft comment is missing a file path')
  const body = payload.body.trim()
  if (!body) throw new Error('Draft comment is empty')
  const line = Math.trunc(payload.line)
  if (!Number.isFinite(line) || line < 1) throw new Error(`Draft comment has an invalid line: ${payload.line}`)
  const side: CommentSide = payload.side === 'left' ? 'left' : 'right'

  return repo.create(
    { prId: ctx.prId, repositoryId: ctx.repositoryId, filePath, line, side, body },
    'claude',
    ctx.reviewSessionId
  )
}
