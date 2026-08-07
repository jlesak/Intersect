import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PrThread } from '@common/domain'
import { splitThreadsByResolution, usePrInboxStore } from '../store'
import { CommentComposer } from './CommentComposer'
import { ThreadCard } from './ThreadCard'

/** One thread of the conversation, wired to the store. */
function Thread({ thread }: { thread: PrThread }) {
  return (
    <ThreadCard
      thread={thread}
      context="overview"
      onReply={(body) => usePrInboxStore.getState().replyToThread(thread.threadId, body)}
      onSetStatus={(status) =>
        usePrInboxStore.getState().setThreadStatus(thread.threadId, status)
      }
      onOpenFile={(path, line) => usePrInboxStore.getState().revealThread(path, line)}
    />
  )
}

/**
 * Every comment thread of the PR on one page, ADO Overview style, led by the threads that still ask
 * for something. The settled ones keep their place at the bottom rather than disappearing: a thread
 * somebody else resolved while I was away is the one I most need to notice, and a list that starts
 * out hiding it can never tell me it changed.
 */
export function OverviewTab() {
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const { unresolved, resolved } = useMemo(() => splitThreadsByResolution(threads), [threads])
  const [composing, setComposing] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  return (
    <div className="ix-overview" data-testid="pr-overview">
      <div className="ix-overview__head">
        <span className="ix-eyebrow">Comments</span>
        <button
          type="button"
          className="ix-btn"
          style={{ marginLeft: 'auto' }}
          data-testid="pr-add-comment"
          onClick={() => setComposing(true)}
        >
          + Comment
        </button>
      </div>
      {composing && (
        <CommentComposer
          label="New PR-level comment"
          onSubmit={async (body) => {
            if (await usePrInboxStore.getState().addComment(null, null, body)) setComposing(false)
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      {unresolved.length === 0 && resolved.length === 0 ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No comments</span>
          <div className="ix-empty__title">Nothing here</div>
          <p className="ix-empty__hint">Nobody has commented on this pull request yet.</p>
        </div>
      ) : (
        unresolved.map((t) => <Thread key={t.threadId} thread={t} />)
      )}
      {resolved.length > 0 && (
        <div className="ix-overview__resolved">
          <button
            type="button"
            className="ix-btn ix-btn--ghost ix-overview__resolved-toggle"
            data-testid="pr-resolved-toggle"
            onClick={() => setShowResolved((open) => !open)}
          >
            {showResolved ? '▾' : '▸'} Resolved
            <span className="ix-board-col__count">{resolved.length}</span>
          </button>
          {showResolved && resolved.map((t) => <Thread key={t.threadId} thread={t} />)}
        </div>
      )}
    </div>
  )
}
