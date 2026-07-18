import type { JiraColumn, JiraIssue, JiraIssueSnapshot, JiraPriority } from '@common/domain'

/** The company Jira host. The single place the renderer-visible issue URLs are anchored to. */
export const JIRA_HOST = 'jira.skoda.vwgroup.com'
export const JIRA_BASE_URL = `https://${JIRA_HOST}`

/** The global My Work board query: my unresolved issues. Deliberately not user-configurable. */
export const JIRA_GLOBAL_JQL = 'assignee = currentUser() AND resolution = EMPTY'

/** One issue as reported by the hidden fetch session, before any normalization. */
export interface RawJiraIssue {
  key: string
  summary: string
  /** The Jira workflow status name, e.g. "In Progress". */
  status: string
  /** The Jira priority name, e.g. "High", or null when the issue has none. */
  priority: string | null
  /** Last activity as the ISO timestamp Jira reports in the `updated` field. */
  updated: string
}

/**
 * Jira workflow status -> board column. Matches on keywords rather than exact names so renamed or
 * unforeseen statuses still land in a sensible column; anything unrecognized (including plain
 * "To Do" / "Open" / "Backlog") falls back to To Do. Test is checked before Review and Review
 * before Waiting so compound names ("Ready for Test", "Waiting for review") land in the most
 * specific column.
 */
export function mapStatusToColumn(status: string): JiraColumn {
  const s = status.trim().toLowerCase()
  if (/\b(test|testing|qa)\b/.test(s)) return 'test'
  if (s.includes('review')) return 'review'
  if (s.includes('wait') || s.includes('hold') || s.includes('block')) return 'waiting'
  if (s.includes('progress') || s.includes('develop') || s.includes('doing') || s.includes('implement')) {
    return 'progress'
  }
  return 'todo'
}

const HIGH_PRIORITIES = new Set(['highest', 'high', 'blocker', 'critical'])
const MEDIUM_PRIORITIES = new Set(['medium', 'major', 'normal'])
const LOW_PRIORITIES = new Set(['low', 'lowest', 'minor', 'trivial'])

/** Jira priority name -> the card's three-bucket priority; null when absent or unrecognized. */
export function mapPriority(priority: string | null): JiraPriority | null {
  if (!priority) return null
  const p = priority.trim().toLowerCase()
  if (HIGH_PRIORITIES.has(p)) return 'high'
  if (MEDIUM_PRIORITIES.has(p)) return 'medium'
  if (LOW_PRIORITIES.has(p)) return 'low'
  return null
}

/**
 * One issue as the direct Jira adapter reports it from either fetch path (JQL search or Agile
 * board), before the cache stamps it with fetch metadata. `updatedAt` is already epoch ms.
 */
export interface JiraRemoteIssue {
  key: string
  summary: string
  description: string | null
  rawStatus: string
  rawPriority: string | null
  assignee: string | null
  epicKey: string | null
  epicSummary: string | null
  estimateSeconds: number | null
  components: string[]
  updatedAt: number
}

/**
 * Normalize directly fetched issues into cache-ready snapshots: canonical browse URL built from
 * the key, status/priority mapped to their buckets with the raw values preserved, the fetch
 * moment stamped on, and the list sorted by last activity, newest first. Entries without a key
 * are dropped.
 */
export function toSnapshots(raw: JiraRemoteIssue[], fetchedAt: number): JiraIssueSnapshot[] {
  const issues: JiraIssueSnapshot[] = []
  for (const entry of raw) {
    const key = entry.key.trim()
    if (!key) continue
    issues.push({
      key,
      url: `${JIRA_BASE_URL}/browse/${key}`,
      summary: entry.summary,
      column: mapStatusToColumn(entry.rawStatus),
      priority: mapPriority(entry.rawPriority),
      updatedAt: entry.updatedAt,
      description: entry.description,
      rawStatus: entry.rawStatus,
      rawPriority: entry.rawPriority,
      assignee: entry.assignee,
      epicKey: entry.epicKey,
      epicSummary: entry.epicSummary,
      estimateSeconds: entry.estimateSeconds,
      components: entry.components,
      fetchedAt,
      absent: false
    })
  }
  issues.sort((a, b) => b.updatedAt - a.updatedAt)
  return issues
}

/**
 * Normalize the reported issues into the board's shape: canonical browse URL built from the key
 * (never trusting a reported URL), status mapped to a column, and the whole list sorted by last
 * activity, newest first. Entries without a key are dropped; an unparseable timestamp sorts last.
 */
export function toIssues(raw: RawJiraIssue[]): JiraIssue[] {
  const issues: JiraIssue[] = []
  for (const entry of raw) {
    const key = entry.key.trim()
    if (!key) continue
    const updatedAt = Date.parse(entry.updated)
    issues.push({
      key,
      url: `${JIRA_BASE_URL}/browse/${key}`,
      summary: entry.summary,
      column: mapStatusToColumn(entry.status),
      priority: mapPriority(entry.priority),
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt
    })
  }
  issues.sort((a, b) => b.updatedAt - a.updatedAt)
  return issues
}
