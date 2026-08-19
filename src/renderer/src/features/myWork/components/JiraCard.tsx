import type { JiraIssue, JiraPriority } from '@common/domain'
import { launchFromJiraIssue } from '@renderer/features/workItems'
import type { MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { RowActions } from '@renderer/shared/ui/RowActions'
import { formatRelativeTime, useMyWorkStore } from '../store'

// Steeper triangle = higher priority, matching the approved mockup's three glyphs.
const PRIORITY_PATHS: Record<JiraPriority, string> = {
  high: 'M8 2l6 12H2z',
  medium: 'M8 3l6 10H2z',
  low: 'M8 4l6 8H2z'
}

const PRIORITY_LABELS: Record<JiraPriority, string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority'
}

function PriorityMark({ priority }: { priority: JiraPriority }) {
  return (
    <span className={`ix-mw-prio ix-mw-prio--${priority}`} title={PRIORITY_LABELS[priority]}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
        <path d={PRIORITY_PATHS[priority]} />
      </svg>
    </span>
  )
}

/**
 * One board card: key, priority, summary, last activity, and the actions the issue offers.
 *
 * Activating the card starts a Claude session on the issue - the thing this app exists to do -
 * and the bar's primary button says so, so the gesture is advertised rather than guessed at.
 * Holding Cmd or Ctrl opens the issue in Jira instead, by click and by Enter alike, so the card
 * means one thing whichever way it is reached.
 */
export function JiraCard({ issue, overflow }: { issue: JiraIssue; overflow?: MenuEntry[] }) {
  const start = (): void => launchFromJiraIssue(issue)
  const open = (): void => useMyWorkStore.getState().openIssue(issue)
  const entries: MenuEntry[] = [
    { label: 'Copy link', onClick: () => void useMyWorkStore.getState().copyIssueLink(issue) },
    ...(overflow && overflow.length > 0 ? [{ separator: true } as MenuEntry, ...overflow] : [])
  ]
  return (
    <div
      role="button"
      tabIndex={0}
      className="ix-mw-card2"
      // The card's own name, so a screen reader announces the issue rather than reading out the
      // labels of the buttons the bar nests inside it.
      aria-label={`${issue.key}: ${issue.summary}`}
      title={`${issue.key} · ${issue.summary}`}
      onClick={(e) => (e.metaKey || e.ctrlKey ? open() : start())}
      onKeyDown={(e) => {
        // A press on a bar button belongs to that button; the bar's own handler runs it.
        if (e.target !== e.currentTarget) return
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) open()
        else start()
      }}
    >
      <span className="ix-mw-card2__top">
        <span className="ix-mw-key">{issue.key}</span>
        {issue.priority && <PriorityMark priority={issue.priority} />}
      </span>
      <span className="ix-mw-card2__title">{issue.summary}</span>
      <span className="ix-mw-card2__bottom">
        <span className="ix-mw-time">{formatRelativeTime(issue.updatedAt)}</span>
      </span>
      <RowActions
        primary={{ label: 'Start session', onClick: start }}
        external={{ label: 'Jira', onClick: open }}
        overflow={entries}
      />
    </div>
  )
}
