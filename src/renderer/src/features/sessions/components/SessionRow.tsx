import type { ReactNode } from 'react'
import type { SessionSummary } from '@common/domain'
import { formatDuration, useSessionsStore } from '../store'

const whenFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

/**
 * The searchable snippet for a row: the first user prompt containing the query (with the match
 * highlighted), falling back to the first prompt. Returns null when the session has no prompts.
 */
function snippet(prompts: string[], query: string): ReactNode {
  if (prompts.length === 0) return null
  const q = query.trim()
  const matched = q ? prompts.find((p) => p.toLowerCase().includes(q.toLowerCase())) : undefined
  const text = (matched ?? prompts[0]).replace(/\s+/g, ' ').trim()
  if (!matched || !q) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="ix-session-row__mark">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

/** One session in the list: title, last-activity time, a meta line, and a matched-prompt snippet. */
export function SessionRow({
  session,
  active,
  query
}: {
  session: SessionSummary
  active: boolean
  query: string
}) {
  const select = (): void => void useSessionsStore.getState().select(session.id)
  const snip = snippet(session.userPrompts, query)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`ix-session-row${active ? ' ix-session-row--active' : ''}`}
      onMouseDown={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
    >
      <span className="ix-session-row__title">{session.title}</span>
      <span className="ix-session-row__when">{whenFormat.format(session.lastTimestamp)}</span>
      <div className="ix-session-row__meta">
        <span>{session.folderName}</span>
        {session.gitBranch && <span className="ix-session-row__branch">{session.gitBranch}</span>}
        <span>{session.messageCount} messages</span>
        <span>⏱ {formatDuration(session.durationMs)}</span>
      </div>
      {snip && <div className="ix-session-row__snip">{snip}</div>}
    </div>
  )
}
