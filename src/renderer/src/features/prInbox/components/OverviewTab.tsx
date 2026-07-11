import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectFilteredThreads, usePrInboxStore } from '../store'
import { CommentComposer } from './CommentComposer'
import { ThreadCard } from './ThreadCard'

const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' }
] as const

/** Every comment thread of the PR on one page, ADO Overview style. */
export function OverviewTab() {
  const threads = usePrInboxStore(useShallow(selectFilteredThreads))
  const filter = usePrInboxStore((s) => s.threadFilter)
  const [composing, setComposing] = useState(false)

  return (
    <div className="ix-overview" data-testid="pr-overview">
      <div className="ix-overview__head">
        <span className="ix-eyebrow">Comments</span>
        <select
          className="ix-input ix-overview__filter"
          value={filter}
          data-testid="pr-thread-filter"
          onChange={(e) =>
            usePrInboxStore.getState().setThreadFilter(e.target.value as typeof filter)
          }
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
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
            await usePrInboxStore.getState().addComment(null, null, body)
            setComposing(false)
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      {threads.length === 0 ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No comments</span>
          <div className="ix-empty__title">Nothing here</div>
          <p className="ix-empty__hint">No threads match the current filter.</p>
        </div>
      ) : (
        threads.map((t) => (
          <ThreadCard
            key={t.threadId}
            thread={t}
            context="overview"
            onReply={(body) => usePrInboxStore.getState().replyToThread(t.threadId, body)}
            onSetStatus={(status) => usePrInboxStore.getState().setThreadStatus(t.threadId, status)}
            onOpenFile={(path, line) => usePrInboxStore.getState().revealThread(path, line)}
          />
        ))
      )}
    </div>
  )
}
