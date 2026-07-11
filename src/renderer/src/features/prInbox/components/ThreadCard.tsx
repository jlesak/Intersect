import { useState } from 'react'
import type { PrThread } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'

interface ThreadCardProps {
  thread: PrThread
  onReply(body: string): Promise<void> | void
  onSetStatus(status: 'active' | 'fixed'): Promise<void> | void
  /** 'overview' additionally shows the file:line chip that jumps to the code. */
  context?: 'inline' | 'overview'
  onOpenFile?(path: string, line: number | null): void
}

const timeAgo = (ms: number): string => {
  if (!ms) return ''
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** One ADO comment thread: conversation, status chip, reply box, resolve/reactivate. */
export function ThreadCard({
  thread,
  onReply,
  onSetStatus,
  context = 'inline',
  onOpenFile
}: ThreadCardProps) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const unresolved = isThreadUnresolved(thread)

  const submit = async (): Promise<void> => {
    const body = reply.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await onReply(body)
      setReply('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ix-thread" data-testid="pr-thread">
      {context === 'overview' && (
        <button
          type="button"
          className="ix-thread__ctx"
          data-testid="pr-thread-ctx"
          disabled={!thread.filePath}
          onClick={() => thread.filePath && onOpenFile?.(thread.filePath, thread.line)}
        >
          {thread.filePath
            ? `${thread.filePath}${thread.line ? `:${thread.line}` : ''}`
            : 'PR-level'}
        </button>
      )}
      <div className="ix-thread__head">
        <span className={`ix-chip${unresolved ? ' ix-chip--accent' : ''}`}>
          {unresolved ? 'Active' : 'Resolved'}
        </span>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          data-testid="pr-thread-toggle"
          disabled={busy}
          onClick={() => void onSetStatus(unresolved ? 'fixed' : 'active')}
        >
          {unresolved ? 'Resolve' : 'Reactivate'}
        </button>
      </div>
      {thread.comments.map((c, i) => (
        <div key={i} className="ix-thread__comment">
          <span className="ix-thread__author">{c.authorName}</span>
          <span className="ix-thread__time">{timeAgo(c.publishedAt)}</span>
          <p className="ix-thread__body">{c.body}</p>
        </div>
      ))}
      <div className="ix-thread__reply">
        <input
          className="ix-input"
          placeholder="Reply…"
          value={reply}
          data-testid="pr-thread-reply"
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            if (e.key === 'Escape') e.stopPropagation()
          }}
        />
        <button
          type="button"
          className="ix-btn"
          data-testid="pr-thread-reply-send"
          disabled={!reply.trim() || busy}
          onClick={() => void submit()}
        >
          Reply
        </button>
      </div>
    </div>
  )
}
