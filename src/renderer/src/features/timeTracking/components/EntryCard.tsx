import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TimeEntry } from '@common/domain'
import { effectiveProject, indexOverrides, resolveJiraProject } from '@common/projectAssign'
import { formatDuration, useSessionsStore } from '@renderer/features/sessions'
import { useProjectsStore } from '@renderer/features/projects'
import { IconPlay, IconTrash } from '@renderer/shared/ui/icons'
import { ContextMenu } from '@renderer/shared/ui/ContextMenu'
import { useTimeTrackingStore } from '../store'
import { normalizeIssueKey, parseDuration } from '../time'

/** Manual entries retain their dot marker; auto cards use the Resume action instead. */
function SourceIcon({ source }: { source: TimeEntry['source'] }) {
  if (source === 'auto') return null
  if (source === 'group') return <span className="ix-tt-card__source" title="Group">G</span>
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
export function EntryCard({ entry, selected = false, onSelect }: {
  entry: TimeEntry
  selected?: boolean
  onSelect?: (shift: boolean) => void
}) {
  const projectName = useProjectsStore((s) => entry.source === 'manual' && entry.projectId
    ? s.projects.find((p) => p.id === (entry.issueKey
      ? effectiveProject('jira', entry.issueKey,
        resolveJiraProject(entry.issueKey, s.projects), indexOverrides(s.overrides))
      : entry.projectId))?.name ?? 'Other' : null)
  const [key, setKey] = useState(entry.issueKey ?? '')
  const [desc, setDesc] = useState(entry.description)
  const [time, setTime] = useState(formatDuration(entry.durationMs))
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
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
    if (entry.source === 'group') void useTimeTrackingStore.getState()
      .updateGroup(entry.id, { issueKey })
    else void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
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
    if (entry.source === 'group') void useTimeTrackingStore.getState()
      .updateGroup(entry.id, { description })
    else void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
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
    if (entry.source === 'group') void useTimeTrackingStore.getState()
      .updateGroup(entry.id, { durationMs })
    else void useTimeTrackingStore.getState().updateEntry(entry, draftPayload())
  }

  return (
    <div className={`ix-tt-card${selected ? ' ix-tt-card--selected' : ''}`}
      onMouseDownCapture={e => {
        if ((e.metaKey || e.shiftKey) && (e.target as HTMLElement).closest('input')) {
          e.preventDefault()
        }
      }}
      onClick={e => {
        if (!onSelect || !(e.metaKey || e.shiftKey)) return
        if ((e.target as HTMLElement).closest('button')) return
        onSelect(e.shiftKey)
      }} onContextMenu={e => {
      if (entry.source !== 'auto') return
      e.preventDefault()
      setMenuAt({ x: e.clientX, y: e.clientY })
    }}>
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
        {entry.source === 'auto' && entry.isWork === false &&
          <span className="ix-tt-card__nonwork" title="Nepracovní karta">nepracovní</span>}
        <span className="ix-tt-card__actions">
          {entry.source === 'group' && <button type="button" className="ix-iconbtn"
            title={expanded ? 'Skrýt členy' : 'Zobrazit členy'}
            aria-label={expanded ? 'Skrýt členy' : 'Zobrazit členy'}
            onClick={() => setExpanded(!expanded)}>{expanded ? '▴' : '▾'}</button>}
          {entry.source === 'auto' && entry.resumable && (
            <button type="button" className="ix-iconbtn" title="Resume" aria-label="Resume"
              onClick={() => useSessionsStore.getState().requestResume({
                id: entry.sessionId, cwd: entry.cwd,
                title: draftPayload().description
              }, 'card')}>
              <IconPlay width={11} height={11} />
            </button>
          )}
          {entry.source === 'group' ? <button type="button" className="ix-btn ix-btn--ghost"
            onClick={() => void useTimeTrackingStore.getState().ungroup(entry.id)}>Rozdělit</button> : <button
            type="button"
            className="ix-iconbtn"
            title="Delete"
            onClick={() => void useTimeTrackingStore.getState().removeEntry(entry)}
          >
            <IconTrash width={11} height={11} />
          </button>}
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
      {entry.source === 'group' && expanded && <div className="ix-tt-card__members">
        {entry.members.map(member => <div key={`${member.source}:${member.id}`}
          className="ix-tt-card__member">
          <span>{member.issueKey ?? '—'} · {member.description} · {formatDuration(member.durationMs)}</span>
          <button type="button" className="ix-iconbtn" title="Delete member"
            onClick={() => void useTimeTrackingStore.getState().removeEntry(member)}>
            <IconTrash width={11} height={11} />
          </button>
        </div>)}
      </div>}
      {entry.source === 'auto' && menuAt && <ContextMenu x={menuAt.x} y={menuAt.y}
        onClose={() => setMenuAt(null)} entries={[
          ...(entry.isWork === false && !entry.workConfirmed ? [{ label: 'Je pracovní',
            onClick: () => { void useTimeTrackingStore.getState().confirmWork(entry) } }] : []),
          { label: entry.resumable ? 'Přegenerovat' : 'Přegenerovat (přepis není dostupný)',
            disabled: !entry.resumable,
            onClick: () => { void useTimeTrackingStore.getState().regenerate(entry) } }
        ]} />}
    </div>
  )
}
