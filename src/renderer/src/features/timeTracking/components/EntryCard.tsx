import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TimeEntry } from '@common/domain'
import { effectiveProject, indexOverrides, resolveJiraProject } from '@common/projectAssign'
import { formatDuration, useSessionsStore } from '@renderer/features/sessions'
import { useProjectsStore } from '@renderer/features/projects'
import { IconPlay, IconTrash } from '@renderer/shared/ui/icons'
import { useTimeTrackingStore } from '../store'
import { normalizeIssueKey, parseDuration } from '../time'

/** Manual entries retain their dot marker; auto cards use the Resume action instead. */
function SourceIcon({ source }: { source: TimeEntry['source'] }) {
  if (source === 'auto') return null
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
  const projectName = useProjectsStore((s) => entry.source === 'manual' && entry.projectId
    ? s.projects.find((p) => p.id === (entry.issueKey
      ? effectiveProject('jira', entry.issueKey,
        resolveJiraProject(entry.issueKey, s.projects), indexOverrides(s.overrides))
      : entry.projectId))?.name ?? 'Other' : null)
  const [key, setKey] = useState(entry.issueKey ?? '')
  const [desc, setDesc] = useState(entry.description)
  const [time, setTime] = useState(formatDuration(entry.durationMs))
  // A ref (not state) so the Escape keydown is already visible to the blur it triggers.
  const discardRef = useRef(false)

  const editing = useRef({ key: false, desc: false, time: false })
  const pending = useRef({ key: false, desc: false, time: false })
  const dirty = useRef({ key: false, desc: false, time: false })
  useEffect(() => {
    if (!editing.current.key && !dirty.current.key) {
      pending.current.key = false
      setKey(entry.issueKey ?? '')
    }
  }, [entry.issueKey])
  useEffect(() => {
    if (!editing.current.desc && !dirty.current.desc) {
      pending.current.desc = false
      setDesc(entry.description)
    }
  }, [entry.description])
  useEffect(() => {
    if (!editing.current.time && !dirty.current.time) {
      pending.current.time = false
      setTime(formatDuration(entry.durationMs))
    }
  }, [entry.durationMs])

  const takeDiscard = (): boolean => {
    const discarded = discardRef.current
    discardRef.current = false
    return discarded
  }

  // Edited or pending fields come from drafts; untouched fields keep the exact current measurement.
  // updateEntry is fire-and-forget and the board reloads only after it resolves, so committing one
  // field while another already holds an uncommitted edit must carry that pending edit too, or the
  // stale prop would silently revert it.
  const draftPayload = () => ({
    description: dirty.current.desc || pending.current.desc ? desc.trim() || entry.description : entry.description,
    issueKey: dirty.current.key || pending.current.key ? normalizeIssueKey(key) : entry.issueKey,
    durationMs: dirty.current.time || pending.current.time ? parseDuration(time) ?? entry.durationMs : entry.durationMs
  })

  const commitKey = (): void => {
    editing.current.key = false

    if (takeDiscard()) {
      pending.current.key = false
      setKey(entry.issueKey ?? '')
      return
    }
    if (!dirty.current.key) {
      if (!pending.current.key) setKey(entry.issueKey ?? '')
      return
    }
    const issueKey = normalizeIssueKey(key)
    if (issueKey === entry.issueKey) {
      setKey(issueKey ?? '')
      return
    }
    pending.current.key = true
    void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  const commitDesc = (): void => {
    editing.current.desc = false

    if (takeDiscard()) {
      pending.current.desc = false
      setDesc(entry.description)
      return
    }
    if (!dirty.current.desc) {
      if (!pending.current.desc) setDesc(entry.description)
      return
    }
    const description = desc.trim()
    if (description === '' || description === entry.description) {
      setDesc(entry.description)
      return
    }
    pending.current.desc = true
    void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  const commitTime = (): void => {
    editing.current.time = false

    if (takeDiscard()) {
      pending.current.time = false
      setTime(formatDuration(entry.durationMs))
      return
    }
    if (!dirty.current.time) {
      if (!pending.current.time) setTime(formatDuration(entry.durationMs))
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
    pending.current.time = true
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
          onFocus={() => { editing.current.key = true }}
          onChange={(e) => {
            dirty.current.key = true
            setKey(e.target.value)
          }}
          onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
          onBlur={() => {
            commitKey()
            dirty.current.key = false
          }}
        />
        <span className="ix-tt-card__actions">
          {entry.source === 'auto' && entry.resumable && (
            <button type="button" className="ix-iconbtn" title="Resume" aria-label="Resume"
              onClick={() => useSessionsStore.getState().requestResume({
                id: entry.sessionId, cwd: entry.cwd,
                title: draftPayload().description
              }, 'card')}>
              <IconPlay width={11} height={11} />
            </button>
          )}
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
      {projectName && <span className="ix-tt-card__project">{projectName}</span>}
      <input
        className="ix-tt-card__title"
        value={desc}
        aria-label="Description"
        onFocus={() => { editing.current.desc = true }}
          onChange={(e) => {
            dirty.current.desc = true
            setDesc(e.target.value)
          }}
        onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
        onBlur={() => {
            commitDesc()
            dirty.current.desc = false
          }}
      />
      <span className="ix-tt-card__bottom">
        <input
          className="ix-tt-card__dur"
          value={time}
          aria-label="Time spent"
          onFocus={() => { editing.current.time = true }}
          onChange={(e) => {
            dirty.current.time = true
            setTime(e.target.value)
          }}
          onKeyDown={(e) => blurOnEnter(e, () => (discardRef.current = true))}
          onBlur={() => {
            commitTime()
            dirty.current.time = false
          }}
        />
      </span>
    </div>
  )
}
