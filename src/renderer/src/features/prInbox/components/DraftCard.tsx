import { useState } from 'react'
import type { DraftComment } from '@common/domain'
import { Dialog } from '@renderer/shared/ui/Dialog'
import { usePrInboxStore } from '../store'

/**
 * One draft review comment. Approve publishes it to Azure DevOps under my identity (an outward,
 * irreversible action, so it goes through an explicit confirm). Edit rewrites the body in place;
 * Discard drops it. A published draft is frozen - only its status shows.
 */
export function DraftCard({ draft }: { draft: DraftComment }) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(draft.body)
  const [confirming, setConfirming] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const published = draft.status === 'published'
  const inFlight = draft.status === 'publishing'

  const commitEdit = (): void => {
    const next = body.trim()
    if (next && next !== draft.body) void usePrInboxStore.getState().editDraft(draft.id, next)
    setEditing(false)
  }

  return (
    <div className="jv-pr-draft">
      <div className="jv-pr-draft__meta">
        <span className={`jv-pr-draft__badge jv-pr-draft__badge--${draft.source}`}>
          {draft.source === 'claude' ? 'Claude' : 'Manual'}
        </span>
        <span className="jv-faint">
          {draft.filePath}:{draft.line}
        </span>
        <span className="jv-pr-draft__status">{draft.status}</span>
      </div>

      {editing ? (
        <textarea
          className="jv-input jv-pr-draft__edit"
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
        <p className="jv-pr-draft__body">{draft.body}</p>
      )}

      <div className="jv-pr-draft__actions">
        {editing ? (
          <>
            <button type="button" className="jv-btn jv-btn--ghost" onClick={() => {
              setBody(draft.body)
              setEditing(false)
            }}>
              Cancel
            </button>
            <button type="button" className="jv-btn jv-btn--primary" onClick={commitEdit}>
              Save
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="jv-btn jv-btn--primary"
              disabled={published || inFlight || publishing}
              onClick={() => setConfirming(true)}
            >
              {published ? 'Published' : 'Approve'}
            </button>
            <button
              type="button"
              className="jv-btn jv-btn--ghost"
              disabled={published || inFlight}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="jv-btn jv-btn--danger"
              disabled={published || inFlight}
              onClick={() => void usePrInboxStore.getState().discardDraft(draft.id)}
            >
              Discard
            </button>
          </>
        )}
      </div>

      {confirming && (
        <Dialog
          title="Publish to Azure DevOps?"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button type="button" className="jv-btn jv-btn--ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="jv-btn jv-btn--primary"
                disabled={publishing}
                onClick={() => {
                  setPublishing(true)
                  setConfirming(false)
                  void usePrInboxStore
                    .getState()
                    .publishDraft(draft.id)
                    .finally(() => setPublishing(false))
                }}
              >
                Publish
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This posts the comment on <strong>{draft.filePath}:{draft.line}</strong> to the pull
            request under your identity. This cannot be undone from Jarvis.
          </p>
        </Dialog>
      )}
    </div>
  )
}
