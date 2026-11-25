import { useState } from 'react'
import type { AgentRuntimeDay, MeetingProposal, TimeEntry } from '@common/domain'
import { IconPlus } from '@renderer/shared/ui/icons'
import { formatAgentRuntime, formatDayDate, formatTotal, totalMs } from '../time'
import { AddEntryForm } from './AddEntryForm'
import { EntryCard } from './EntryCard'
import { MeetingProposalCard } from './MeetingProposalCard'
import { useMeetingsStore } from '../meetingsStore'

/**
 * One weekday of the board: a header with the day's name, date and total, the day's cards, and
 * the "+ Add entry" affordance which swaps into the inline form. Today's column is highlighted.
 * `runtime`, when present, is the day's agent-runtime supporting figure - read-only context shown
 * distinctly from the worklog cards, never itself a worklog.
 */
export function DayColumn({
  day,
  name,
  entries,
  isToday,
  runtime,
  proposals = []
}: {
  day: string
  name: string
  entries: TimeEntry[]
  isToday: boolean
  runtime?: AgentRuntimeDay
  proposals?: MeetingProposal[]
}) {
  const [adding, setAdding] = useState(false)
  const total = totalMs(entries)

  return (
    <div className={`ix-tt__day${isToday ? ' ix-tt__day--today' : ''}`} data-day={day}>
      <div className="ix-tt__day-head">
        <div className="ix-tt__day-name">
          {name}
          {isToday && <span className="ix-tt__day-badge">TODAY</span>}
        </div>
        <div className="ix-tt__day-date">{formatDayDate(day)}</div>
        <div className="ix-tt__day-total">{entries.length === 0 ? '—' : formatTotal(total)}</div>
      </div>
      {runtime && (
        <div className="ix-tt__day-runtime ix-ctx__hint" data-runtime-day={day}>
          {formatAgentRuntime(runtime)}
          {runtime.hasLowConfidence && (
            <span className="ix-tt__day-runtime-approx" title="Includes coarse transcript estimate">
              {' '}
              ~approx
            </span>
          )}
        </div>
      )}
      <div className="ix-tt__day-body">
        {isToday && proposals.length > 0 && <div className="ix-tt-proposal__all">
          <span>{proposals.length} meeting {proposals.length === 1 ? 'suggestion' : 'suggestions'}</span>
          <button type="button" className="ix-btn ix-btn--ghost"
            onClick={() => void useMeetingsStore.getState().acceptAll(day)}>Accept all</button>
        </div>}
        {isToday && proposals.map((proposal) => <MeetingProposalCard
          key={`${proposal.source}:${proposal.externalId}`} proposal={proposal} />)}
        {entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} />
        ))}
        {adding ? (
          <AddEntryForm day={day} onClose={() => setAdding(false)} />
        ) : (
          <button type="button" className="ix-tt__add" onClick={() => setAdding(true)}>
            <IconPlus width={11} height={11} />
            Add entry
          </button>
        )}
      </div>
    </div>
  )
}
