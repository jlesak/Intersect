import type { JiraErrorKind } from '@common/domain'
import type { RawJiraIssue } from './jiraMapping'

/**
 * The single report message the jira MCP server forwards over the Unix socket for one fetch
 * session. `kind`/`message` are meaningful only when `ok` is false; `issues` only when it is true.
 */
export interface JiraReportPayload {
  sessionId: string
  ok: boolean
  kind: JiraErrorKind
  message: string
  issues: RawJiraIssue[]
}

/**
 * Parse one newline-delimited JSON report line into a fully-typed payload; throws on malformed
 * JSON. Field types are coerced and non-object issue entries dropped, so a confused session can
 * degrade the data but never crash main or smuggle unexpected shapes past this boundary.
 */
export function parseJiraReport(raw: string): JiraReportPayload {
  const obj = JSON.parse(raw) as Record<string, unknown>
  const rawIssues = Array.isArray(obj.issues) ? obj.issues : []
  const issues: RawJiraIssue[] = rawIssues
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      key: String(entry.key ?? ''),
      summary: String(entry.summary ?? ''),
      status: String(entry.status ?? ''),
      priority: entry.priority == null ? null : String(entry.priority),
      updated: String(entry.updated ?? '')
    }))
  return {
    sessionId: String(obj.sessionId ?? ''),
    ok: obj.ok === true,
    kind: obj.error === 'auth' ? 'auth' : 'other',
    message: String(obj.message ?? ''),
    issues
  }
}
