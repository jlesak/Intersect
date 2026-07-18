import { describe, expect, test } from 'vitest'
import {
  BOARD_BASE_JQL,
  createJiraClient,
  formatErrorChain,
  parseJiraBoardUrl,
  type JiraClient
} from './jiraClient'

const BOARD_URL = 'https://jira.skoda.vwgroup.com/secure/RapidBoard.jspa?rapidView=51682&projectKey=FID2507'
const BOARD_URL_WITH_QF = `${BOARD_URL}&quickFilter=84114`

interface RecordedCall {
  url: string
  method: string
  body?: unknown
}

interface Scripted {
  status: number
  body?: unknown
}

/**
 * A scripted fetch queue with full call capture, so tests can assert the exact URLs, methods,
 * and JQL the adapter sends. Responses are consumed in order; the last one repeats.
 */
function makeClient(opts: {
  responses: Scripted[]
  calls?: RecordedCall[]
  session?: string | null
  pageSize?: number
  pageCeiling?: number
}): JiraClient {
  let i = 0
  return createJiraClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const r = opts.responses[Math.min(i, opts.responses.length - 1)]
      i += 1
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      opts.calls?.push({ url: String(input), method: init?.method ?? 'GET', body })
      return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, { status: r.status })
    }) as typeof fetch,
    now: () => 1000,
    readSession: async () =>
      opts.session === null ? null : { cookieHeader: opts.session ?? 'JSESSIONID=abc' },
    pageSize: opts.pageSize,
    pageCeiling: opts.pageCeiling
  })
}

/** The /rest/api/2/field answer that discovers no Epic Link field (skips epic enrichment). */
const NO_EPIC_FIELD: Scripted = { status: 200, body: [] }

function searchHit(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    fields: {
      summary: `Issue ${key}`,
      description: null,
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      assignee: { displayName: 'Jan Lesák' },
      updated: '2026-07-17T10:00:00.000+0200',
      timeoriginalestimate: 3600,
      components: [{ name: 'Backend' }],
      ...over
    }
  }
}

describe('parseJiraBoardUrl', () => {
  test('reads rapidView as the board id', () => {
    expect(parseJiraBoardUrl(BOARD_URL)).toEqual({ boardId: 51682, quickFilterId: null })
  })

  test('reads quickFilter when present', () => {
    expect(parseJiraBoardUrl(BOARD_URL_WITH_QF)).toEqual({ boardId: 51682, quickFilterId: 84114 })
  })

  test('returns null for nonsense', () => {
    expect(parseJiraBoardUrl(null)).toBeNull()
    expect(parseJiraBoardUrl('')).toBeNull()
    expect(parseJiraBoardUrl('not a url')).toBeNull()
    expect(parseJiraBoardUrl('https://jira.test/browse/FID-1')).toBeNull()
    expect(parseJiraBoardUrl('https://jira.test/?rapidView=notnumeric')).toBeNull()
  })

  test('trims whitespace before parsing', () => {
    expect(parseJiraBoardUrl(`  ${BOARD_URL}  `)).toEqual({ boardId: 51682, quickFilterId: null })
  })
})

describe('formatErrorChain', () => {
  test('walks err.cause so undici "fetch failed" reveals the real reason', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND jira'), { code: 'ENOTFOUND' })
    const err = new Error('fetch failed')
    ;(err as { cause?: unknown }).cause = cause
    expect(formatErrorChain(err)).toBe('fetch failed -> getaddrinfo ENOTFOUND jira [ENOTFOUND]')
  })
})

describe('searchByJql', () => {
  test('sends the JQL through the read-only search POST and normalizes the issues', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: { issues: [searchHit('FID2507-1')], total: 1 } }
      ]
    })
    const result = await client.searchByJql('assignee = currentUser() AND resolution = EMPTY')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.partial).toBe(false)
    expect(result.issues).toEqual([
      {
        key: 'FID2507-1',
        summary: 'Issue FID2507-1',
        description: null,
        rawStatus: 'In Progress',
        rawPriority: 'High',
        assignee: 'Jan Lesák',
        epicKey: null,
        epicSummary: null,
        estimateSeconds: 3600,
        components: ['Backend'],
        updatedAt: Date.parse('2026-07-17T10:00:00.000+0200')
      }
    ])

    const search = calls[1]
    expect(search.method).toBe('POST')
    expect(new URL(search.url).pathname).toBe('/rest/api/2/search')
    const body = search.body as { jql: string; fields: string[] }
    expect(body.jql).toBe('assignee = currentUser() AND resolution = EMPTY')
    // The richer snapshot fields must be requested explicitly.
    for (const field of ['summary', 'description', 'status', 'priority', 'assignee', 'updated', 'timeoriginalestimate', 'components']) {
      expect(body.fields).toContain(field)
    }
  })

  test('pages with startAt until the total is reached', async () => {
    const calls: RecordedCall[] = []
    const page1 = Array.from({ length: 2 }, (_, i) => searchHit(`A-${i + 1}`))
    const page2 = [searchHit('A-3')]
    const client = makeClient({
      calls,
      pageSize: 2,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: { issues: page1, total: 3 } },
        { status: 200, body: { issues: page2, total: 3 } }
      ]
    })
    const result = await client.searchByJql('x = y')
    expect(result.ok && result.issues.length).toBe(3)
    const bodies = calls.slice(1).map((c) => c.body as { startAt: number })
    expect(bodies.map((b) => b.startAt)).toEqual([0, 2])
  })

  test('the pagination ceiling returns an explicit partial envelope with what was fetched', async () => {
    const fullPage = { status: 200, body: { issues: [searchHit('A-1')], total: 1000 } }
    const client = makeClient({
      pageSize: 1,
      pageCeiling: 3,
      responses: [NO_EPIC_FIELD, fullPage, fullPage, fullPage, fullPage]
    })
    const result = await client.searchByJql('x = y')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.partial).toBe(true)
    expect(result.issues).toHaveLength(3)
  })

  test('a missing session is an auth failure without any request', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({ session: null, calls, responses: [{ status: 200 }] })
    const result = await client.searchByJql('x = y')
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
    expect(calls).toHaveLength(0)
  })

  test.each([[301], [302], [401], [403]])('a %s answer is an auth failure', async (status) => {
    const client = makeClient({ responses: [NO_EPIC_FIELD, { status }] })
    const result = await client.searchByJql('x = y')
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
  })

  test('a 500 answer is a server failure carrying the status and body', async () => {
    const client = makeClient({
      responses: [NO_EPIC_FIELD, { status: 500, body: { message: 'boom' } }]
    })
    const result = await client.searchByJql('x = y')
    expect(result).toMatchObject({ ok: false, kind: 'server' })
    if (result.ok) return
    expect(result.message).toMatch(/500/)
  })

  test('a thrown fetch is a network failure with the cause chain in the message', async () => {
    const client = createJiraClient({
      fetch: (async () => {
        const err = new Error('fetch failed')
        ;(err as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED'
        })
        throw err
      }) as typeof fetch,
      now: () => 1000,
      readSession: async () => ({ cookieHeader: 'x=y' })
    })
    const result = await client.searchByJql('x = y')
    expect(result).toMatchObject({ ok: false, kind: 'network' })
    if (result.ok) return
    expect(result.message).toMatch(/ECONNREFUSED/)
  })

  test('discovers the Epic Link custom field and enriches issues with epic summaries', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        { status: 200, body: [{ id: 'customfield_10006', name: 'Epic Link' }, { id: 'x', name: 'Sprint' }] },
        {
          status: 200,
          body: { issues: [searchHit('FID2507-9', { customfield_10006: 'FID2507-100' })], total: 1 }
        },
        {
          status: 200,
          body: { issues: [{ key: 'FID2507-100', fields: { summary: 'Direct Jira sync' } }] }
        }
      ]
    })
    const result = await client.searchByJql('x = y')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues[0].epicKey).toBe('FID2507-100')
    expect(result.issues[0].epicSummary).toBe('Direct Jira sync')

    expect(new URL(calls[0].url).pathname).toBe('/rest/api/2/field')
    expect(calls[0].method).toBe('GET')
    // The discovered field is added to the requested fields.
    expect((calls[1].body as { fields: string[] }).fields).toContain('customfield_10006')
    // Epic summaries go through the read-only search POST as a key batch.
    expect((calls[2].body as { jql: string }).jql).toBe('key in (FID2507-100)')
  })

  test('a failed epic summary lookup degrades to the epic key without a summary', async () => {
    const client = makeClient({
      responses: [
        { status: 200, body: [{ id: 'customfield_10006', name: 'Epic Link' }] },
        {
          status: 200,
          body: { issues: [searchHit('A-1', { customfield_10006: 'E-1' })], total: 1 }
        },
        { status: 500, body: {} }
      ]
    })
    const result = await client.searchByJql('x = y')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues[0].epicKey).toBe('E-1')
    expect(result.issues[0].epicSummary).toBeNull()
  })
})

describe('fetchBoard', () => {
  test('hits the Agile board endpoint with the unresolved-only base JQL', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: { issues: [searchHit('FID2507-1')], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: null })
    expect(result.ok).toBe(true)
    const board = new URL(calls[1].url)
    expect(board.pathname).toBe('/rest/agile/1.0/board/51682/issue')
    expect(calls[1].method).toBe('GET')
    expect(board.searchParams.get('jql')).toBe(BOARD_BASE_JQL)
    expect(board.searchParams.get('fields')).toContain('description')
    expect(board.searchParams.get('fields')).toContain('assignee')
  })

  test('resolves the quick filter via the LIST endpoint and parenthesizes its JQL (array shape)', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        NO_EPIC_FIELD,
        {
          status: 200,
          body: [
            { id: 12345, name: 'Other', jql: 'project = OTHER' },
            { id: 84114, name: 'Mine', jql: 'priority = Highest OR labels = urgent' }
          ]
        },
        { status: 200, body: { issues: [], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })
    expect(result.ok).toBe(true)
    expect(new URL(calls[1].url).pathname).toBe('/rest/agile/1.0/board/51682/quickfilter')
    expect(new URL(calls[2].url).searchParams.get('jql')).toBe(
      `(priority = Highest OR labels = urgent) AND ${BOARD_BASE_JQL}`
    )
  })

  test('accepts the paginated {values: [...]} quick filter shape', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: { isLast: true, values: [{ id: 84114, jql: 'labels = urgent' }] } },
        { status: 200, body: { issues: [], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })
    expect(result.ok).toBe(true)
    expect(new URL(calls[2].url).searchParams.get('jql')).toBe(`(labels = urgent) AND ${BOARD_BASE_JQL}`)
  })

  test('an unknown quick filter degrades to the base filter with a warning', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: [{ id: 99999, jql: 'foo = bar' }] },
        { status: 200, body: { issues: [searchHit('A-1')], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warning).toMatch(/84114/)
    expect(result.issues).toHaveLength(1)
    expect(new URL(calls[2].url).searchParams.get('jql')).toBe(BOARD_BASE_JQL)
  })

  test('a 404 from the quick filter LIST endpoint degrades to the base filter with a warning', async () => {
    const client = makeClient({
      responses: [
        NO_EPIC_FIELD,
        { status: 404, body: { message: 'HTTP 404 Not Found' } },
        { status: 200, body: { issues: [searchHit('A-1')], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warning).toMatch(/84114/)
    expect(result.issues).toHaveLength(1)
  })

  test('an auth failure on the quick filter lookup aborts hard', async () => {
    const client = makeClient({
      responses: [NO_EPIC_FIELD, { status: 401 }]
    })
    const result = await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
  })

  test('paginates the board endpoint with startAt until isLast', async () => {
    const calls: RecordedCall[] = []
    const page1 = Array.from({ length: 2 }, (_, i) => searchHit(`B-${i + 1}`))
    const client = makeClient({
      calls,
      pageSize: 2,
      responses: [
        NO_EPIC_FIELD,
        { status: 200, body: { issues: page1, isLast: false } },
        { status: 200, body: { issues: [searchHit('B-3')], isLast: true } }
      ]
    })
    const result = await client.fetchBoard({ boardId: 7, quickFilterId: null })
    expect(result.ok && result.issues.length).toBe(3)
    expect(new URL(calls[1].url).searchParams.get('startAt')).toBe('0')
    expect(new URL(calls[2].url).searchParams.get('startAt')).toBe('2')
  })

  test('the board pagination ceiling returns an explicit partial envelope', async () => {
    const fullPage = { status: 200, body: { issues: [searchHit('B-1')], isLast: false } }
    const client = makeClient({
      pageSize: 1,
      pageCeiling: 2,
      responses: [NO_EPIC_FIELD, fullPage, fullPage, fullPage]
    })
    const result = await client.fetchBoard({ boardId: 7, quickFilterId: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.partial).toBe(true)
    expect(result.issues).toHaveLength(2)
  })

  test('a 401 from the board endpoint is an auth failure that keeps nothing', async () => {
    const client = makeClient({ responses: [NO_EPIC_FIELD, { status: 401 }] })
    const result = await client.fetchBoard({ boardId: 7, quickFilterId: null })
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
  })
})

describe('read-only guarantee', () => {
  test('every request across both paths is a GET or the read-only search POST', async () => {
    const calls: RecordedCall[] = []
    const client = makeClient({
      calls,
      responses: [
        // searchByJql: field discovery, one page, epic summaries.
        { status: 200, body: [{ id: 'customfield_10006', name: 'Epic Link' }] },
        {
          status: 200,
          body: { issues: [searchHit('A-1', { customfield_10006: 'E-1' })], total: 1 }
        },
        { status: 200, body: { issues: [{ key: 'E-1', fields: { summary: 'Epic' } }] } },
        // fetchBoard with a quick filter: list, board pages, epic summaries.
        { status: 200, body: [{ id: 84114, jql: 'labels = urgent' }] },
        {
          status: 200,
          body: { issues: [searchHit('B-1', { customfield_10006: 'E-1' })], isLast: true }
        },
        { status: 200, body: { issues: [{ key: 'E-1', fields: { summary: 'Epic' } }] } }
      ]
    })
    await client.searchByJql('assignee = currentUser()')
    await client.fetchBoard({ boardId: 51682, quickFilterId: 84114 })

    expect(calls.length).toBeGreaterThanOrEqual(6)
    for (const call of calls) {
      const path = new URL(call.url).pathname
      if (call.method === 'POST') {
        // The single permitted POST is Jira's read-only search endpoint.
        expect(path).toBe('/rest/api/2/search')
      } else {
        expect(call.method).toBe('GET')
        expect(
          path === '/rest/api/2/field' ||
            /^\/rest\/agile\/1\.0\/board\/\d+\/(issue|quickfilter)$/.test(path)
        ).toBe(true)
      }
    }
  })

  test('the client surface has no mutation methods', () => {
    const client = makeClient({ responses: [{ status: 200 }] })
    expect(Object.keys(client).sort()).toEqual(['fetchBoard', 'searchByJql'])
  })

  test('requests carry the SSO cookie and manual redirects (the auth-expiry signal)', async () => {
    let captured: RequestInit | undefined
    const client = createJiraClient({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        captured ??= init
        return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 })
      }) as typeof fetch,
      now: () => 1000,
      readSession: async () => ({ cookieHeader: 'JSESSIONID=abc; TS=xyz' })
    })
    await client.searchByJql('x = y')
    expect(captured?.redirect).toBe('manual')
    expect((captured?.headers as Record<string, string>).Cookie).toBe('JSESSIONID=abc; TS=xyz')
  })
})
