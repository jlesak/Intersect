import { useState } from 'react'
import type { AgentRuntimeDay, TimeEntry } from '@common/domain'
import { IconPlus } from '@renderer/shared/ui/icons'
import { formatAgentRuntime, formatDayDate, formatTotal, totalMs } from '../time'
import { AddEntryForm } from './AddEntryForm'
import { EntryCard } from './EntryCard'

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
  runtime
}: {
  day: string
  name: string
  entries: TimeEntry[]
  isToday: boolean
  runtime?: AgentRuntimeDay
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
