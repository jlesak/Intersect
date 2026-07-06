import type { JiraIssue, JiraPriority } from '@common/domain'
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

/** One board card: key, priority, summary, and last activity. Clicking opens the issue in the browser. */
export function JiraCard({ issue }: { issue: JiraIssue }) {
  return (
    <button
      type="button"
      className="ix-mw-card2"
      title={`${issue.key} · ${issue.summary}`}
      onClick={() => useMyWorkStore.getState().openIssue(issue)}
    >
      <span className="ix-mw-card2__top">
        <span className="ix-mw-key">{issue.key}</span>
        {issue.priority && <PriorityMark priority={issue.priority} />}
      </span>
      <span className="ix-mw-card2__title">{issue.summary}</span>
      <span className="ix-mw-card2__bottom">
        <span className="ix-mw-time">{formatRelativeTime(issue.updatedAt)}</span>
      </span>
    </button>
  )
}
