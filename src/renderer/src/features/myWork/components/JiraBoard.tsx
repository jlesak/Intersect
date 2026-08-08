import { useMemo, useState } from 'react'
import { JIRA_COLUMNS, type JiraColumn, type JiraIssue, type JiraIssueSnapshot } from '@common/domain'
import { MultiSelectFilter } from '@renderer/shared/ui/MultiSelectFilter'
import { type JiraBoardFilter, NO_JIRA_FILTER, filterJiraIssues, jiraFilterOptions } from '../boardFilter'
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
 * The five-column kanban board over the fetched issues, with a bar for narrowing it down to the
 * one the user is after. `onIssueContextMenu` lets an embedding surface (the project Kanban)
 * attach a per-card menu without the board knowing about it.
 *
 * The narrowing lives in the board rather than in the store because the same board is on screen
 * more than once at a time - two projects side by side - and typing into one of them must not
 * quietly reach into the others.
 */
export function JiraBoard({
  issues,
  onIssueContextMenu
}: {
  issues: JiraIssueSnapshot[]
  onIssueContextMenu?: (issue: JiraIssue, x: number, y: number) => void
}) {
  const [filter, setFilter] = useState<JiraBoardFilter>(NO_JIRA_FILTER)
  const options = useMemo(() => jiraFilterOptions(issues), [issues])
  const shown = useMemo(() => filterJiraIssues(issues, filter), [issues, filter])
  const board = useMemo(() => groupByColumn(shown), [shown])
  return (
    <>
      <div className="ix-boardfilter">
        <input
          className="ix-input ix-boardfilter__search"
          type="search"
          placeholder="Filter by key, summary or assignee…"
          data-testid="jira-filter"
          value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
        />
        <MultiSelectFilter
          label="Epic"
          testId="jira-filter-epic"
          options={options.epics}
          selection={filter.epics}
          onChange={(epics) => setFilter((f) => ({ ...f, epics }))}
        />
        <MultiSelectFilter
          label="Component"
          testId="jira-filter-component"
          options={options.components}
          selection={filter.components}
          onChange={(components) => setFilter((f) => ({ ...f, components }))}
        />
        {shown.length !== issues.length && (
          <span className="ix-boardfilter__count" data-testid="jira-filter-count">
            {shown.length} of {issues.length}
          </span>
        )}
      </div>
      {/* Every column collapses when nothing survives, and a row of unlabelled strips looks like a
          board that failed to load rather than one that found nothing. */}
      {shown.length === 0 && issues.length > 0 && (
        <div className="ix-boardfilter__none">No issues match this filter.</div>
      )}
      <div className="ix-mw-board">
        {JIRA_COLUMNS.map((column) => (
          <div
            key={column}
            className={`ix-mw-col ix-mw-col--${column}${board[column].length === 0 ? ' ix-mw-col--collapsed' : ''}`}
          >
            <ColumnHead column={column} count={board[column].length} />
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
    </>
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
