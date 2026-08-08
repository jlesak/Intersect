import type { ReactNode } from 'react'
import type { SessionSummary } from '@common/domain'
import { bestPromptMatch } from '../search'
import { formatDuration, useSessionsStore } from '../store'

const whenFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

/**
 * How much of a long prompt to keep in front of the first matched character. A match a thousand
 * characters into a pasted stack trace would otherwise sit past the row's ellipsis, leaving the
 * user looking at a preview that shows no sign of why the row is there.
 */
const LEAD_IN = 24

/**
 * The one-line preview for a row: the prompt best answering the current query, with every matched
 * character marked, wound forward to the match when it starts far into a long prompt. Returns null
 * when the session has no prompts at all.
 */
function snippet(prompts: string[], query: string): ReactNode {
  const match = bestPromptMatch(query, prompts)
  if (!match) return null

  const { text } = match
  const start = match.indices.length > 0 && match.indices[0] > LEAD_IN ? match.indices[0] - LEAD_IN : 0

  // Adjacent matched characters become one highlight rather than a row of one-letter boxes.
  const runs: Array<[number, number]> = []
  for (const index of match.indices) {
    const last = runs[runs.length - 1]
    if (last && last[1] === index) last[1] = index + 1
    else runs.push([index, index + 1])
  }

  const parts: ReactNode[] = []
  let at = start
  for (const [from, to] of runs) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="ix-session-row__mark">
        {text.slice(from, to)}
      </mark>
    )
    at = to
  }
  parts.push(text.slice(at))

  return (
    <>
      {start > 0 && '…'}
      {parts}
    </>
  )
}

/**
 * One session in the list: title, last-activity time, a meta line, and a matched-prompt snippet.
 * Only the row the list is currently pointed at takes a Tab stop, so Tab enters and leaves the
 * list as one control and the arrow keys walk it from there; the list owns those keys.
 */
export function SessionRow({
  session,
  active,
  query,
  focused,
  onFocus
}: {
  session: SessionSummary
  active: boolean
  query: string
  focused: boolean
  onFocus: () => void
}) {
  const select = (): void => void useSessionsStore.getState().select(session.id)
  const snip = snippet(session.userPrompts, query)
  return (
    <div
      role="button"
      tabIndex={focused ? 0 : -1}
      className={`ix-session-row${active ? ' ix-session-row--active' : ''}`}
      onMouseDown={select}
      onFocus={onFocus}
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
