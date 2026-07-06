import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptEntry } from '@common/domain'
import { formatDuration, useSessionsStore } from '../store'

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/** Full date-time for the start and time-only for the end of a same-context range. */
function formatRange(from: number, to: number): string {
  return `${dateTime.format(from)} – ${timeOnly.format(to)}`
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  const roleLabel = entry.role === 'user' ? 'You' : 'Claude'
  return (
    <div className={`ix-transcript__entry ix-transcript__entry--${entry.role}`}>
      <span className="ix-transcript__role">{roleLabel}</span>
      <div className="ix-transcript__body">
        {entry.text && (
          <div className="ix-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          </div>
        )}
        {entry.tools.map((tool, i) => (
          <div key={i} className="ix-transcript__tool">
            {tool}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The read-only conversation for the selected session, with a Resume action in the header. */
export function TranscriptViewer() {
  const selectedId = useSessionsStore((s) => s.selectedId)
  const summary = useSessionsStore((s) => s.all.find((x) => x.id === s.selectedId) ?? null)
  const transcript = useSessionsStore((s) => s.transcript)
  const transcriptStatus = useSessionsStore((s) => s.transcriptStatus)

  if (!selectedId) {
    return (
      <div className="ix-sessions-transcript ix-sessions-transcript--empty">
        <div className="ix-empty">
          <span className="ix-eyebrow">No session</span>
          <div className="ix-empty__title">Nothing selected</div>
          <p className="ix-empty__hint">
            Pick a session from the list to read its transcript and resume it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ix-sessions-transcript">
      <div className="ix-transcript__header">
        <div className="ix-transcript__heading">
          <span className="ix-transcript__title">{summary?.title ?? transcript?.title ?? ''}</span>
          {summary && (
            <span className="ix-transcript__range">
              {formatRange(summary.firstTimestamp, summary.lastTimestamp)} · ⏱{' '}
              {formatDuration(summary.durationMs)}
            </span>
          )}
        </div>
        {summary && (
          <button
            type="button"
            className="ix-btn ix-btn--primary"
            onClick={() => useSessionsStore.getState().requestResume(summary)}
          >
            Resume
          </button>
        )}
      </div>

      <div className="ix-transcript__body-scroll">
        {transcriptStatus === 'loading' && <span className="ix-faint">Loading transcript…</span>}
        {transcriptStatus === 'error' && (
          <span className="ix-faint">Could not load this transcript.</span>
        )}
        {transcriptStatus === 'ready' && transcript && transcript.entries.length === 0 && (
          <span className="ix-faint">This session has no readable messages.</span>
        )}
        {transcriptStatus === 'ready' &&
          transcript?.entries.map((entry, i) => <Entry key={i} entry={entry} />)}
      </div>
    </div>
  )
}
