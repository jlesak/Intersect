import type { JiraSyncErrorKind } from '@common/domain'
import { JIRA_BASE_URL, type JiraRemoteIssue } from './jiraMapping'
import type { JiraSession } from './jiraSession'

/**
 * The direct, strictly read-only Jira adapter. It authenticates with the browser-captured SSO
 * cookies (never a token), speaks only two endpoints families - GET reads plus the read-only
 * `POST /rest/api/2/search` - and normalizes both fetch paths (JQL search and Agile board) into
 * the same issue shape. It has no transition, edit, comment, or worklog capability by
 * construction: no method here issues anything but those reads.
 */
export interface JiraClient {
  /** Fetch every issue the JQL selects, paging through the search endpoint. */
  searchByJql(jql: string): Promise<JiraFetchResult>
  /** Fetch a rapid board's issues (quick filter applied when resolvable), via the Agile API. */
  fetchBoard(board: ParsedBoardUrl): Promise<JiraFetchResult>
}

/**
 * The outcome of one direct fetch. `partial: true` means the pagination ceiling cut the result
 * short - whatever was fetched is returned, explicitly flagged. `warning` carries a non-fatal
 * degradation (e.g. a quick filter that could not be resolved). A failure is data, never a
 * thrown error.
 */
export type JiraFetchResult =
  | { ok: true; issues: JiraRemoteIssue[]; partial: boolean; warning?: string }
  | { ok: false; kind: Exclude<JiraSyncErrorKind, 'not-configured'>; message: string }

export interface JiraClientDeps {
  fetch: typeof fetch
  now(): number
  /** The saved SSO session; null means login is needed and no request is attempted. */
  readSession(): Promise<JiraSession | null>
  baseUrl?: string
  pageSize?: number
  pageCeiling?: number
}

/** Parsed Jira rapid-board URL components. */
export interface ParsedBoardUrl {
  boardId: number
  quickFilterId: number | null
}

/**
 * Parse a Jira RapidBoard URL into a board id (`rapidView=...`) and an optional quick filter id
 * (`quickFilter=...`). Returns null for anything that is not a recognizable URL or lacks a
 * numeric `rapidView`.
 */
export function parseJiraBoardUrl(raw: string | null | undefined): ParsedBoardUrl | null {
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  const rapid = parsed.searchParams.get('rapidView')
  if (!rapid) return null
  const boardId = Number(rapid)
  if (!Number.isFinite(boardId) || boardId <= 0) return null
  const qf = parsed.searchParams.get('quickFilter')
  const quickFilterId = qf != null ? Number(qf) : NaN
  return {
    boardId,
    quickFilterId: Number.isFinite(quickFilterId) && quickFilterId > 0 ? quickFilterId : null
  }
}

/**
 * Render the whole `err.cause` chain, because Node's undici fetch reports a bare "fetch failed"
 * while the real reason (ENOTFOUND, certificate chain, ECONNREFUSED) hides in the cause.
 */
export function formatErrorChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  let depth = 0
  while (current && depth < 5) {
    const e = current as { message?: string; code?: string; cause?: unknown }
    const piece = e.code ? `${e.message ?? '(no message)'} [${e.code}]` : (e.message ?? String(current))
    parts.push(piece)
    if (!e.cause) break
    current = e.cause
    depth += 1
  }
  return parts.join(' -> ')
}

const DEFAULT_PAGE_SIZE = 100
/** Safety net so a buggy `isLast=false` (or a runaway total) can never loop forever. */
const DEFAULT_PAGE_CEILING = 10

/**
 * The narrowing applied on top of a board's own saved filter, mirroring the global query's
 * unresolved-only scope: the five-column board has no Done column, so resolved issues would
 * otherwise pile into the To Do fallback.
 */
export const BOARD_BASE_JQL = 'resolution = EMPTY'

/** Every remote field both fetch paths request; the discovered epic-link field is appended. */
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'assignee',
  'updated',
  'timeoriginalestimate',
  'components'
]

/** The auth-expiry signature: Jira answers 401/403 itself, the SSO front redirects to the IdP. */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403 || (status >= 300 && status < 400)
}

/** The raw hit shape shared by `/rest/api/2/search` and the Agile board issue endpoint. */
interface JiraIssueHit {
  key?: string
  fields?: {
    summary?: string
    description?: string | null
    status?: { name?: string }
    priority?: { name?: string } | null
    assignee?: { displayName?: string } | null
    updated?: string
    timeoriginalestimate?: number | null
    components?: Array<{ name?: string }>
    [customField: string]: unknown
  }
}

/** The Epic Link custom field holds either the bare key string or an object carrying one. */
function readEpicKey(hit: JiraIssueHit, fieldId: string | null): string | null {
  if (!fieldId) return null
  const raw = hit.fields?.[fieldId]
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (raw && typeof raw === 'object' && 'key' in raw) {
    const k = (raw as { key: unknown }).key
    if (typeof k === 'string' && k.length > 0) return k
  }
  return null
}

function toRemoteIssue(
  hit: JiraIssueHit,
  epicFieldId: string | null,
  epicSummaries: Map<string, string>
): JiraRemoteIssue {
  const f = hit.fields ?? {}
  const description = typeof f.description === 'string' ? f.description.trim() : ''
  const epicKey = readEpicKey(hit, epicFieldId)
  const updatedAt = Date.parse(f.updated ?? '')
  return {
    key: hit.key ?? '',
    summary: f.summary ?? '',
    description: description.length > 0 ? description : null,
    rawStatus: f.status?.name ?? '',
    rawPriority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    epicKey,
    epicSummary: epicKey ? (epicSummaries.get(epicKey) ?? null) : null,
    estimateSeconds: f.timeoriginalestimate ?? null,
    components: (f.components ?? []).map((c) => c.name ?? '').filter((n) => n.length > 0),
    updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt
  }
}

interface RawQuickFilter {
  id: unknown
  jql?: unknown
}

/**
 * The Agile quickfilter LIST endpoint answers in one of two shapes depending on the Jira
 * version: paginated `{ values: [...] }` or a raw array. Accept both; anything without an `id`
 * is dropped silently.
 */
function readQuickFilters(data: unknown): RawQuickFilter[] {
  const raw: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { values?: unknown }).values)
      ? (data as { values: unknown[] }).values
      : []
  return raw.filter(
    (x): x is RawQuickFilter =>
      typeof x === 'object' && x !== null && 'id' in (x as Record<string, unknown>)
  )
}

export function createJiraClient(deps: JiraClientDeps): JiraClient {
  const baseUrl = deps.baseUrl ?? JIRA_BASE_URL
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const pageCeiling = deps.pageCeiling ?? DEFAULT_PAGE_CEILING

  // The Epic Link field id is a per-instance customfield discovered at runtime; memoized for
  // the process lifetime (it never changes on a given Jira instance).
  let epicFieldId: string | null | undefined

  type HttpFailure = { ok: false; kind: 'auth' | 'network' | 'server'; message: string }

  /** One read request with the session cookie; every failure classified into the error kinds. */
  async function request(
    session: JiraSession,
    url: string,
    init: { method: 'GET' } | { method: 'POST'; body: unknown }
  ): Promise<{ ok: true; data: unknown } | HttpFailure> {
    let res: Response
    try {
      res = await deps.fetch(url, {
        method: init.method,
        // Manual redirects are load-bearing: the SSO front announces an expired session by
        // redirecting to the identity provider, which must classify as auth, not follow.
        redirect: 'manual',
        headers: {
          Cookie: session.cookieHeader,
          Accept: 'application/json',
          ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {})
      })
    } catch (err) {
      return { ok: false, kind: 'network', message: formatErrorChain(err) }
    }
    if (isAuthFailure(res.status)) {
      return { ok: false, kind: 'auth', message: 'Jira SSO session expired. Sign in to Jira again.' }
    }
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '')
      return { ok: false, kind: 'server', message: `Jira HTTP ${res.status}: ${text.slice(0, 400) || 'no body'}` }
    }
    const data = (await res.json().catch(() => null)) as unknown
    return { ok: true, data }
  }

  /** Discover the Epic Link customfield id; best-effort - null skips epic enrichment. */
  async function discoverEpicFieldId(session: JiraSession): Promise<string | null> {
    if (epicFieldId !== undefined) return epicFieldId
    const res = await request(session, `${baseUrl}/rest/api/2/field`, { method: 'GET' })
    if (!res.ok || !Array.isArray(res.data)) {
      // Only a definitive answer is memoized; a transient failure retries on the next fetch.
      return null
    }
    const epicLink = (res.data as Array<{ id?: string; name?: string }>).find(
      (f) => f && f.name === 'Epic Link'
    )
    epicFieldId = epicLink?.id ?? null
    return epicFieldId
  }

  /** Batch-fetch summaries for the epic keys via the read-only search POST. Best-effort. */
  async function fetchEpicSummaries(
    session: JiraSession,
    epicKeys: string[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (epicKeys.length === 0) return result
    const res = await request(session, `${baseUrl}/rest/api/2/search`, {
      method: 'POST',
      body: { jql: `key in (${epicKeys.join(',')})`, fields: ['summary'], maxResults: epicKeys.length }
    })
    if (!res.ok) return result
    const data = res.data as { issues?: Array<{ key?: string; fields?: { summary?: string } }> } | null
    for (const issue of data?.issues ?? []) {
      if (issue.key && issue.fields?.summary) result.set(issue.key, issue.fields.summary)
    }
    return result
  }

  /** Normalize collected hits, enriching epic links with their summaries. */
  async function finalize(
    session: JiraSession,
    hits: JiraIssueHit[],
    fieldId: string | null,
    partial: boolean,
    warning: string | undefined
  ): Promise<JiraFetchResult> {
    const epicKeys = new Set<string>()
    for (const hit of hits) {
      const key = readEpicKey(hit, fieldId)
      if (key) epicKeys.add(key)
    }
    const epicSummaries = await fetchEpicSummaries(session, [...epicKeys])
    const issues = hits.map((hit) => toRemoteIssue(hit, fieldId, epicSummaries))
    return { ok: true, issues, partial, ...(warning ? { warning } : {}) }
  }

  return {
    async searchByJql(jql) {
      const session = await deps.readSession()
      if (!session) {
        return { ok: false, kind: 'auth', message: 'Not logged in: no saved Jira SSO session.' }
      }
      const fieldId = await discoverEpicFieldId(session)
      const fields = fieldId ? [...ISSUE_FIELDS, fieldId] : ISSUE_FIELDS

      const hits: JiraIssueHit[] = []
      let startAt = 0
      let partial = false
      for (let page = 0; ; page += 1) {
        if (page >= pageCeiling) {
          partial = true
          break
        }
        const res = await request(session, `${baseUrl}/rest/api/2/search`, {
          method: 'POST',
          body: { jql, fields, startAt, maxResults: pageSize }
        })
        if (!res.ok) return res
        const data = (res.data ?? {}) as { issues?: JiraIssueHit[]; total?: number }
        const pageHits = data.issues ?? []
        hits.push(...pageHits)
        startAt += pageHits.length
        if (pageHits.length < pageSize || startAt >= (data.total ?? 0)) break
      }
      return finalize(session, hits, fieldId, partial, undefined)
    },

    async fetchBoard(board) {
      const session = await deps.readSession()
      if (!session) {
        return { ok: false, kind: 'auth', message: 'Not logged in: no saved Jira SSO session.' }
      }
      const fieldId = await discoverEpicFieldId(session)
      const fields = fieldId ? [...ISSUE_FIELDS, fieldId] : ISSUE_FIELDS

      // Resolve the quick filter to its JQL fragment via the LIST endpoint (the per-id GET 404s
      // on some Jira Server versions). Auth aborts hard; anything else degrades to a warning and
      // the board's own base filter.
      let extraJql: string | null = null
      let warning: string | undefined
      if (board.quickFilterId !== null) {
        const res = await request(
          session,
          `${baseUrl}/rest/agile/1.0/board/${board.boardId}/quickfilter`,
          { method: 'GET' }
        )
        if (!res.ok) {
          if (res.kind === 'auth') return res
          warning = `Quick filter ${board.quickFilterId} could not be applied (${res.message}); showing the board's base filter.`
        } else {
          const found = readQuickFilters(res.data).find((qf) => Number(qf.id) === board.quickFilterId)
          if (!found) {
            warning = `Quick filter ${board.quickFilterId} is not on board ${board.boardId}; showing the board's base filter.`
          } else if (typeof found.jql === 'string' && found.jql.trim().length > 0) {
            extraJql = found.jql.trim()
          }
        }
      }
      // The quick filter side is parenthesized so its OR clauses cannot bleed past the AND.
      const finalJql = extraJql ? `(${extraJql}) AND ${BOARD_BASE_JQL}` : BOARD_BASE_JQL

      const hits: JiraIssueHit[] = []
      let startAt = 0
      let partial = false
      for (let page = 0; ; page += 1) {
        if (page >= pageCeiling) {
          partial = true
          break
        }
        const url = new URL(`${baseUrl}/rest/agile/1.0/board/${board.boardId}/issue`)
        url.searchParams.set('fields', fields.join(','))
        url.searchParams.set('maxResults', String(pageSize))
        url.searchParams.set('startAt', String(startAt))
        url.searchParams.set('jql', finalJql)
        const res = await request(session, url.toString(), { method: 'GET' })
        if (!res.ok) return res
        const data = (res.data ?? {}) as { issues?: JiraIssueHit[]; isLast?: boolean }
        const pageHits = data.issues ?? []
        hits.push(...pageHits)
        startAt += pageHits.length
        if (data.isLast || pageHits.length < pageSize) break
      }
      return finalize(session, hits, fieldId, partial, warning)
    }
  }
}
