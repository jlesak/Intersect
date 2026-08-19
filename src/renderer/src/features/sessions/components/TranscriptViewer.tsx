import { useEffect, useMemo, useRef, useState } from 'react'
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

interface MessageItem {
  kind: 'message'
  id: string
  entry: TranscriptEntry
}

interface ToolBatchItem {
  kind: 'tools'
  id: string
  tools: string[]
}

type TranscriptItem = MessageItem | ToolBatchItem

/**
 * Claude persists tool calls as separate assistant records. Keep those records in the transcript,
 * but present each uninterrupted run as one batch between the human-readable messages around it.
 */
export function groupTranscriptItems(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let pendingTools: string[] = []
  let batchStart = 0

  const flushTools = (): void => {
    if (pendingTools.length === 0) return
    items.push({ kind: 'tools', id: `tools-${batchStart}`, tools: pendingTools })
    pendingTools = []
  }

  entries.forEach((entry, index) => {
    if (entry.role === 'assistant' && entry.tools.length > 0) {
      if (pendingTools.length === 0) batchStart = index
      pendingTools.push(...entry.tools)
    }

    if (entry.text) {
      // Tools in a text-bearing assistant record belong after its visible response, not before it.
      if (entry.role === 'assistant' && entry.tools.length > 0) {
        const tools = pendingTools.splice(-entry.tools.length)
        flushTools()
        items.push({ kind: 'message', id: `message-${index}`, entry: { ...entry, tools: [] } })
        batchStart = index
        pendingTools = tools
      } else {
        flushTools()
        items.push({ kind: 'message', id: `message-${index}`, entry })
      }
    } else if (entry.role === 'user') {
      // Defensive: a malformed empty user turn still forms a conversation boundary.
      flushTools()
    }
  })

  flushTools()
  return items
}

function toolNames(tools: string[]): string {
  const names = [...new Set(tools.map((tool) => tool.split(/[: ]/, 1)[0]))]
  return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')
}

function ToolBatch({ item }: { item: ToolBatchItem }) {
  const [expanded, setExpanded] = useState(false)
  const calls = item.tools.length === 1 ? '1 tool call' : `${item.tools.length} tool calls`
  return (
    <div className="ix-transcript__tool-batch">
      <button
        type="button"
        className="ix-transcript__tool-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden>{expanded ? '⌄' : '›'}</span>
        {calls}
        {toolNames(item.tools) && <span className="ix-transcript__tool-kinds"> · {toolNames(item.tools)}</span>}
      </button>
      {expanded && (
        <div className="ix-transcript__tool-list">
          {item.tools.map((tool, index) => (
            <div key={`${tool}-${index}`} className="ix-transcript__tool">
              {tool}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Entry({ entry, match }: { entry: TranscriptEntry; match: boolean }) {
  const roleLabel = entry.role === 'user' ? 'You' : 'Claude'
  return (
    <div
      className={`ix-transcript__entry ix-transcript__entry--${entry.role}${
        match ? ' ix-transcript__entry--match' : ''
      }`}
    >
      <span className="ix-transcript__role">{roleLabel}</span>
      <div className="ix-transcript__body">
        {entry.text && (
          <div className="ix-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          </div>
        )}
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
  const resumingThis = useSessionsStore((s) => s.resumingId !== null && s.resumingId === s.selectedId)
  // Resumes run one at a time, so the action stays blocked while any of them is under way rather
  // than accepting a click the app layer would then quietly drop.
  const resumeBusy = useSessionsStore((s) => s.resumingId !== null)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const matchRefs = useRef(new Map<string, HTMLDivElement>())
  const items = useMemo(() => groupTranscriptItems(transcript?.entries ?? []), [transcript])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingMessageIds = useMemo(
    () =>
      normalizedQuery === ''
        ? []
        : items
            .filter(
              (item): item is MessageItem =>
                item.kind === 'message' && item.entry.text.toLocaleLowerCase().includes(normalizedQuery)
            )
            .map((item) => item.id),
    [items, normalizedQuery]
  )

  // A transcript-specific query should never leak into the next session the user opens.
  useEffect(() => {
    setQuery('')
    setActiveMatch(0)
  }, [selectedId])

  useEffect(() => {
    setActiveMatch((current) => Math.min(current, Math.max(0, matchingMessageIds.length - 1)))
  }, [matchingMessageIds.length])

  useEffect(() => {
    if (matchingMessageIds.length === 0) return
    matchRefs.current.get(matchingMessageIds[activeMatch])?.scrollIntoView?.({ block: 'center' })
  }, [activeMatch, matchingMessageIds])

  const stepMatch = (direction: 1 | -1): void => {
    if (matchingMessageIds.length === 0) return
    setActiveMatch((current) => (current + direction + matchingMessageIds.length) % matchingMessageIds.length)
  }

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
        <div className="ix-transcript__actions">
          <div className="ix-transcript__search">
            <input
              className="ix-input ix-transcript__search-input"
              type="search"
              aria-label="Search messages in this session"
              placeholder="Find in session…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveMatch(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('')
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stepMatch(event.shiftKey ? -1 : 1)
                }
              }}
            />
            {normalizedQuery !== '' && (
              <span className="ix-transcript__match-count" aria-live="polite">
                {matchingMessageIds.length === 0
                  ? 'No matches'
                  : `${activeMatch + 1} / ${matchingMessageIds.length}`}
              </span>
            )}
            <button
              type="button"
              className="ix-btn ix-btn--icon"
              aria-label="Previous matching message"
              disabled={matchingMessageIds.length === 0}
              onClick={() => stepMatch(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="ix-btn ix-btn--icon"
              aria-label="Next matching message"
              disabled={matchingMessageIds.length === 0}
              onClick={() => stepMatch(1)}
            >
              ↓
            </button>
          </div>
          {summary && (
            <button
              type="button"
              className="ix-btn ix-btn--primary"
              disabled={resumeBusy}
              onClick={() => useSessionsStore.getState().requestResume(summary)}
            >
              {resumingThis && <span className="ix-spinner" aria-hidden />}
              {resumingThis ? 'Resuming…' : 'Resume'}
            </button>
          )}
        </div>
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
          items.map((item) =>
            item.kind === 'tools' ? (
              <ToolBatch key={item.id} item={item} />
            ) : (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) matchRefs.current.set(item.id, node)
                  else matchRefs.current.delete(item.id)
                }}
              >
                <Entry entry={item.entry} match={matchingMessageIds.includes(item.id)} />
              </div>
            )
          )}
      </div>
    </div>
  )
}
