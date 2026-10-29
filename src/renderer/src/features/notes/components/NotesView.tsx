import { useEffect, useMemo } from 'react'
import type { NoteEntry } from '@common/domain'
import { noteSearchTerms } from '@common/noteSearch'
import { dayKeyOf } from '@common/week'
import { useNow } from '@renderer/shared/ui/useNow'
import { formatNoteDay } from '../format'
import { useNotesStore } from '../store'
import { NoteCapture } from './NoteCapture'
import { NoteEntryRow } from './NoteEntryRow'
import { NoteFilters } from './NoteFilters'

function EntryList({ entries, terms }: { entries: NoteEntry[]; terms: readonly string[] }) {
  return (
    <div className="ix-notes__entries" role="list">
      {entries.map((entry) => (
        <NoteEntryRow
          key={entry.id}
          entry={entry}
          terms={terms}
          onSave={(body) => useNotesStore.getState().update(entry.id, body)}
          onDelete={() => void useNotesStore.getState().remove(entry.id)}
        />
      ))}
    </div>
  )
}

/**
 * The Notes section's main region: today's note with its capture box, then the search bar, then
 * the past days. The filters narrow only the history; Today always shows every entry it has, with
 * the searched words marked.
 */
export function NotesView() {
  const status = useNotesStore((s) => s.status)
  const error = useNotesStore((s) => s.error)
  const today = useNotesStore((s) => s.today)
  const todayEntries = useNotesStore((s) => s.todayEntries)
  const history = useNotesStore((s) => s.history)
  const historyFiltered = useNotesStore((s) => s.historyFiltered)
  const query = useNotesStore((s) => s.query)

  const terms = useMemo(() => noteSearchTerms(query), [query])

  useEffect(() => {
    void useNotesStore.getState().load()
  }, [])

  // A view left open across midnight moves yesterday's note into the history on its own.
  const currentDay = dayKeyOf(useNow(60_000))
  useEffect(() => {
    if (today !== '' && currentDay !== today) void useNotesStore.getState().load()
  }, [currentDay, today])

  const ready = status === 'ready'
  const noNotes = ready && !historyFiltered && todayEntries.length === 0 && history.length === 0
  const noMatch = ready && historyFiltered && history.length === 0

  return (
    <div className="ix-main">
      <div className="ix-notes">
        <section className="ix-notes__today" aria-label="Today">
          <h2 className="ix-notes__heading">Today</h2>
          {status === 'error' && (
            <div className="ix-notes__error" role="alert">
              Could not load notes{error ? `: ${error}` : ''}
            </div>
          )}
          {noNotes && (
            <div className="ix-notes__empty">No notes yet - write the first one below.</div>
          )}
          <EntryList entries={todayEntries} terms={terms} />
          <NoteCapture />
        </section>

        <section className="ix-notes__history" aria-label="History">
          <h2 className="ix-notes__heading">History</h2>
          <NoteFilters />
          {noMatch && <div className="ix-notes__no-match">No notes match</div>}
          {history.map((day) => (
            <div key={day.day} className="ix-notes__day" data-day={day.day}>
              <h3 className="ix-notes__day-heading">{formatNoteDay(day.day)}</h3>
              <EntryList entries={day.entries} terms={terms} />
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
