import { useState } from 'react'
import type { DraftComment } from '@common/domain'
import { usePrInboxStore } from '../store'

/**
 * One draft review comment. Approve posts it to Azure DevOps under my identity straight away: the
 * card already shows the exact body and anchor that will be published, and reading a draft is the
 * decision, so a confirm on top of it only adds a click to every finding. Edit rewrites the body in
 * place; Discard drops it. A published draft is frozen - only its status shows.
 */
interface DraftCardProps {
  draft: DraftComment
  /** The card is mounted as a Monaco view zone directly under its anchored line. */
  inline?: boolean
  /** The anchored side no longer reaches the recorded line, so Monaco had to clamp placement. */
  positionOutdated?: boolean
  /** The PR head no longer matches the immutable diff snapshot that supplied this anchor. */
  stale?: boolean
}

export function DraftCard({ draft, inline = false, positionOutdated = false, stale = false }: DraftCardProps) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(draft.body)
  const [publishing, setPublishing] = useState(false)

  const published = draft.status === 'published'
  const inFlight = draft.status === 'publishing'

  const commitEdit = (): void => {
    const next = body.trim()
    if (next && next !== draft.body) void usePrInboxStore.getState().editDraft(draft.id, next)
    setEditing(false)
  }

  return (
    <div className={`ix-pr-draft${inline ? ' ix-pr-draft--inline' : ''}`} data-testid="pr-draft">
      <div className="ix-pr-draft__meta">
        <span className={`ix-pr-draft__badge ix-pr-draft__badge--${draft.source}`}>
          {draft.source === 'claude' ? 'Claude' : 'Manual'}
        </span>
        <span className="ix-faint">
          {draft.filePath}:{draft.line}
        </span>
        <span className="ix-pr-draft__status">{draft.status}</span>
      </div>
      {positionOutdated && (
        <span
          className="ix-chip ix-chip--warn"
          data-testid="pr-draft-stale-anchor"
          title={`Written against line ${draft.line} of an earlier version of this file, which no longer reaches that line.`}
        >
          Position approximate
        </span>
      )}
      {stale && (
        <div className="ix-pr-draft__stale" data-testid="pr-draft-stale-source">
          This PR changed after the draft was created. Publishing is blocked; discard it or run
          another Claude review.
        </div>
      )}

      {editing ? (
        <textarea
          className="ix-input ix-pr-draft__edit"
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setBody(draft.body)
              setEditing(false)
            }
          }}
        />
      ) : (
        <p className="ix-pr-draft__body">{draft.body}</p>
      )}

      <div className="ix-pr-draft__actions">
        {editing ? (
          <>
            <button type="button" className="ix-btn ix-btn--ghost" onClick={() => {
              setBody(draft.body)
              setEditing(false)
            }}>
              Cancel
            </button>
            <button
              type="button"
              className="ix-btn ix-btn--primary"
              data-testid="pr-draft-save"
              onClick={commitEdit}
            >
              Save
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ix-btn ix-btn--primary"
              data-testid="pr-draft-approve"
              disabled={published || inFlight || publishing || stale}
              title={
                stale
                  ? 'This draft is anchored to an older PR source commit.'
                  : `Posts this comment on ${draft.filePath}:${draft.line} to the pull request.`
              }
              onClick={() => {
                setPublishing(true)
                void usePrInboxStore
                  .getState()
                  .publishDraft(draft.id)
                  .finally(() => setPublishing(false))
              }}
            >
              {published ? 'Published' : stale ? 'Stale' : 'Approve'}
            </button>
            <button
              type="button"
              className="ix-btn ix-btn--ghost"
              data-testid="pr-draft-edit"
              disabled={published || inFlight}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="ix-btn ix-btn--danger"
              data-testid="pr-draft-discard"
              disabled={published || inFlight}
              onClick={() => void usePrInboxStore.getState().discardDraft(draft.id)}
            >
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  )
}
