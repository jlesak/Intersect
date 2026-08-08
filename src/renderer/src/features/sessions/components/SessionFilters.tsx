import { useShallow } from 'zustand/react/shallow'
import { MultiSelectFilter } from '@renderer/shared/ui/MultiSelectFilter'
import { selectFolders, useSessionsStore } from '../store'

/** Local date (YYYY-MM-DD) for a date input, derived from an epoch-ms bound. */
function toInputValue(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Start of the chosen local day as epoch ms, or null for an empty input. */
function dayStart(value: string): number | null {
  return value ? new Date(`${value}T00:00:00`).getTime() : null
}

/** End of the chosen local day as epoch ms, or null for an empty input. */
function dayEnd(value: string): number | null {
  return value ? new Date(`${value}T23:59:59.999`).getTime() : null
}

/** The folder multiselect: the shared chip control over the folders present in the index. */
function FolderFilter() {
  const allFolders = useSessionsStore(useShallow(selectFolders))
  const folders = useSessionsStore((s) => s.folders)
  return (
    <MultiSelectFilter
      label="Folders"
      testId="sessions-folders"
      options={allFolders.map((name) => ({ value: name, label: name }))}
      selection={folders}
      onChange={(next) => useSessionsStore.getState().setFolders(next)}
    />
  )
}

/** The filters bar: search, a from/to date range, the folder multiselect, and a Refresh + count. */
export function SessionFilters() {
  const query = useSessionsStore((s) => s.query)
  const from = useSessionsStore((s) => s.from)
  const to = useSessionsStore((s) => s.to)
  const total = useSessionsStore((s) => s.all.length)
  const loading = useSessionsStore((s) => s.status === 'loading')

  return (
    <div className="ix-sessions-filters">
      <input
        className="ix-input ix-sessions-search"
        type="search"
        placeholder="Search titles and your prompts…"
        value={query}
        onChange={(e) => useSessionsStore.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Typing and then walking the results is one gesture, so ArrowDown steps out of the box
          // into the list rather than stopping at the end of the query.
          if (e.key !== 'ArrowDown') return
          const first = document.querySelector<HTMLElement>('.ix-session-row')
          if (!first) return
          e.preventDefault()
          first.focus()
        }}
      />
      <div className="ix-sessions-controls">
        <label className="ix-sessions-date">
          <span className="ix-eyebrow">From</span>
          <input
            className="ix-input"
            type="date"
            value={toInputValue(from)}
            onChange={(e) => useSessionsStore.getState().setRange(dayStart(e.target.value), to)}
          />
        </label>
        <label className="ix-sessions-date">
          <span className="ix-eyebrow">To</span>
          <input
            className="ix-input"
            type="date"
            value={toInputValue(to)}
            onChange={(e) => useSessionsStore.getState().setRange(from, dayEnd(e.target.value))}
          />
        </label>
        <FolderFilter />
        <button
          type="button"
          className="ix-btn ix-sessions-refresh"
          disabled={loading}
          onClick={() => void useSessionsStore.getState().refresh()}
        >
          {loading && <span className="ix-spinner" aria-hidden />}
          Refresh <span className="ix-faint">· {total}</span>
        </button>
      </div>
    </div>
  )
}
