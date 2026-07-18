import { useMemo } from 'react'
import { JIRA_COLUMNS, type JiraColumn, type JiraIssue } from '@common/domain'
import { groupByColumn } from '../store'
import { JiraCard } from './JiraCard'

const COLUMN_LABELS: Record<JiraColumn, string> = {
  todo: 'To Do',
  progress: 'Progress',
  waiting: 'Waiting',
  review: 'Review',
  test: 'Test'
}

function ColumnHead({ column, count }: { column: JiraColumn; count?: number }) {
  return (
    <div className="ix-mw-col__head">
      <span className="ix-mw-col__dot" />
      <span className="ix-mw-col__name">{COLUMN_LABELS[column]}</span>
      {count !== undefined && <span className="ix-mw-col__count">{count}</span>}
    </div>
  )
}

/**
 * The five-column kanban board over the fetched issues. `onIssueContextMenu` lets an embedding
 * surface (the project Kanban) attach a per-card menu without the board knowing about it.
 */
export function JiraBoard({
  issues,
  onIssueContextMenu
}: {
  issues: JiraIssue[]
  onIssueContextMenu?: (issue: JiraIssue, x: number, y: number) => void
}) {
  const board = useMemo(() => groupByColumn(issues), [issues])
  return (
    <div className="ix-mw-board">
      {JIRA_COLUMNS.map((column) => (
        <div key={column} className={`ix-mw-col ix-mw-col--${column}`}>
          <ColumnHead column={column} count={board[column].length} />
          {board[column].length === 0 && <div className="ix-mw-col__empty">No issues</div>}
          {board[column].map((issue) =>
            onIssueContextMenu ? (
              <div
                key={issue.key}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onIssueContextMenu(issue, e.clientX, e.clientY)
                }}
              >
                <JiraCard issue={issue} />
              </div>
            ) : (
              <JiraCard key={issue.key} issue={issue} />
            )
          )}
        </div>
      ))}
    </div>
  )
}

// Shimmer counts per column while loading, matching the approved mockup's skeleton.
const SKELETON_ROWS: Record<JiraColumn, number> = {
  todo: 2,
  progress: 1,
  waiting: 1,
  review: 1,
  test: 1
}

/** The board's loading placeholder: headed columns filled with shimmering card-sized blocks. */
export function JiraBoardSkeleton() {
  return (
    <div className="ix-mw-board">
      {JIRA_COLUMNS.map((column) => (
        <div key={column} className={`ix-mw-col ix-mw-col--${column}`}>
          <ColumnHead column={column} />
          {Array.from({ length: SKELETON_ROWS[column] }, (_, i) => (
            <div key={i} className="ix-mw-col__skel" />
          ))}
        </div>
      ))}
    </div>
  )
}
