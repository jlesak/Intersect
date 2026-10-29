import { useNotesStore } from '../store'

/** The history filters: a fulltext search and an inclusive from/to day range, as on Sessions. */
export function NoteFilters() {
  const query = useNotesStore((s) => s.query)
  const from = useNotesStore((s) => s.from)
  const to = useNotesStore((s) => s.to)

  return (
    <div className="ix-notes__filters">
      <input
        className="ix-input ix-notes__search"
        type="search"
        aria-label="Search notes"
        placeholder="Search notes…"
        value={query}
        onChange={(e) => useNotesStore.getState().setQuery(e.target.value)}
      />
      <div className="ix-notes__range">
        <label className="ix-notes__date">
          <span className="ix-eyebrow">From</span>
          <input
            className="ix-input ix-notes__from"
            type="date"
            value={from ?? ''}
            onChange={(e) => useNotesStore.getState().setRange(e.target.value || null, to)}
          />
        </label>
        <label className="ix-notes__date">
          <span className="ix-eyebrow">To</span>
          <input
            className="ix-input ix-notes__to"
            type="date"
            value={to ?? ''}
            onChange={(e) => useNotesStore.getState().setRange(from, e.target.value || null)}
          />
        </label>
      </div>
    </div>
  )
}
