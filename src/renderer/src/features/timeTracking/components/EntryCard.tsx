import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TimeEntry } from '@common/domain'
import { formatDuration } from '@renderer/features/sessions'
import { IconTrash } from '@renderer/shared/ui/icons'
import { useTimeTrackingStore } from '../store'
import { normalizeIssueKey, parseDuration } from '../time'

/** Triangle for an auto entry (tinted), dot for a manual one - matching the approved mockup. */
function SourceIcon({ source }: { source: TimeEntry['source'] }) {
  if (source === 'auto') {
    return (
      <span className="ix-tt-card__source ix-tt-card__source--auto" title="Automatic from Claude Code">
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 2l8 6-8 6z" />
        </svg>
      </span>
    )
  }
  return (
    <span className="ix-tt-card__source" title="Manual entry">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="8" cy="8" r="3" />
      </svg>
    </span>
  )
}

/** Blur on Enter so the input's onBlur is the single commit path; Escape discards first. */
function blurOnEnter(e: KeyboardEvent<HTMLInputElement>, discard?: () => void): void {
  if (e.key === 'Enter') e.currentTarget.blur()
  if (e.key === 'Escape') {
    discard?.()
    e.currentTarget.blur()
  }
}

/**
 * One worklog card. The issue key, the description and the duration are editable in place on every
 * card (auto and manual alike); a failed duration parse reverts to the previous value. Every field
 * commits on blur, so Enter simply blurs.
 */
export function EntryCard({ entry }: { entry: TimeEntry }) {
  const [key, setKey] = useState(entry.issueKey ?? '')
  const [desc, setDesc] = useState(entry.description)
  const [time, setTime] = useState(formatDuration(entry.durationMs))
  // A ref (not state) so the Escape keydown is already visible to the blur it triggers.
  const discardRef = useRef(false)

  useEffect(() => setKey(entry.issueKey ?? ''), [entry.issueKey])
  useEffect(() => setDesc(entry.description), [entry.description])
  useEffect(() => setTime(formatDuration(entry.durationMs)), [entry.durationMs])

  const takeDiscard = (): boolean => {
    const discarded = discardRef.current
    discardRef.current = false
    return discarded
  }

  // Assemble the whole payload from the live drafts of all three fields, never from the entry prop.
  // updateEntry is fire-and-forget and the board reloads only after it resolves, so committing one
  // field while another already holds an uncommitted edit must carry that pending edit too, or the
  // stale prop would silently revert it.
  const draftPayload = () => ({
    description: desc.trim() || entry.description,
    issueKey: normalizeIssueKey(key),
    durationMs: parseDuration(time) ?? entry.durationMs
  })

  const commitKey = (): void => {
    if (takeDiscard()) {
      setKey(entry.issueKey ?? '')
      return
    }
    const issueKey = normalizeIssueKey(key)
    if (issueKey === entry.issueKey) {
      setKey(issueKey ?? '')
      return
    }
    void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  const commitDesc = (): void => {
    if (takeDiscard()) {
      setDesc(entry.description)
      return
    }
    const description = desc.trim()
    if (description === '' || description === entry.description) {
      setDesc(entry.description)
      return
    }
    void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  const commitTime = (): void => {
    if (takeDiscard()) {
      setTime(formatDuration(entry.durationMs))
      return
    }
    // Untouched text is not an edit. The displayed format floors to whole minutes, so parsing it
    // back would differ from a session's ms-precise duration and a mere focus+blur would write an
    // override, silently rounding and freezing an auto card.
    if (time === formatDuration(entry.durationMs)) return
    const durationMs = parseDuration(time)
    if (durationMs === null || durationMs === entry.durationMs) {
      setTime(formatDuration(entry.durationMs))
      return
    }
    void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  return (
    <div className="ix-tt-card">
      <span className="ix-tt-card__top">
        <SourceIcon source={entry.source} />
        <input
          className="ix-tt-card__key"
          value={key}
          placeholder="no issue"
          aria-label="Issue key"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
          onBlur={commitKey}
        />
        <span className="ix-tt-card__actions">
          <button
            type="button"
            className="ix-iconbtn"
            title="Delete"
            onClick={() => void useTimeTrackingStore.getState().removeEntry(entry)}
          >
            <IconTrash width={11} height={11} />
          </button>
        </span>
      </span>
      <input
        className="ix-tt-card__title"
        value={desc}
        aria-label="Description"
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
        onBlur={commitDesc}
      />
      <span className="ix-tt-card__bottom">
        <input
          className="ix-tt-card__dur"
          value={time}
          aria-label="Time spent"
          onChange={(e) => setTime(e.target.value)}
          onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
          onBlur={commitTime}
        />
      </span>
    </div>
  )
}
