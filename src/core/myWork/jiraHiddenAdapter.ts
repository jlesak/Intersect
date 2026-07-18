import type { JiraBoardResult, JiraColumn, JiraPriority } from '@common/domain'
import type { JiraFetchResult } from './jiraClient'
import type { JiraRemoteIssue } from './jiraMapping'

/**
 * Adapts the legacy hidden-Claude fetch result to the direct adapter's shape, so the diagnostic
 * flag can route the global board through the old path while everything downstream (engine,
 * cache, renderer) runs the new model. The legacy result only carries the normalized column and
 * priority bucket, so representative raw names are reconstructed; the extra snapshot fields the
 * hidden path never fetched stay null.
 */

const COLUMN_TO_STATUS: Record<JiraColumn, string> = {
  todo: 'To Do',
  progress: 'In Progress',
  waiting: 'Waiting',
  review: 'In Review',
  test: 'In Test'
}

const PRIORITY_TO_NAME: Record<JiraPriority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low'
}

export function adaptHiddenBoardResult(result: JiraBoardResult): JiraFetchResult {
  if (!result.ok) {
    return { ok: false, kind: result.kind, message: result.message }
  }
  const issues: JiraRemoteIssue[] = result.issues.map((issue) => ({
    key: issue.key,
    summary: issue.summary,
    description: null,
    rawStatus: COLUMN_TO_STATUS[issue.column],
    rawPriority: issue.priority ? PRIORITY_TO_NAME[issue.priority] : null,
    assignee: null,
    epicKey: null,
    epicSummary: null,
    estimateSeconds: null,
    components: [],
    updatedAt: issue.updatedAt
  }))
  return { ok: true, issues, partial: false }
}
