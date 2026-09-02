import { describe, expect, it, vi } from 'vitest'
import { createUsageApi, toClaudeUsage, USAGE_API_PATH } from './usageApi'

/** The response shape the live endpoint returns, trimmed to the fields this app reads. */
const API_RESPONSE = {
  five_hour: {
    utilization: 29.0,
    resets_at: '2026-08-24T22:59:59.384317+00:00',
    limit_dollars: null
  },
  seven_day: {
    utilization: 6.0,
    resets_at: '2026-08-30T16:59:59.384344+00:00',
    limit_dollars: null
  },
  seven_day_opus: null,
  limits: [{ kind: 'session', group: 'session', percent: 29, severity: 'normal' }]
}

const CAPTURED_AT = 1787600000000

function okFetch(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
}

function api(fetchImpl: typeof fetch, token: string | null = 'sk-oauth-token') {
  return createUsageApi({
    fetch: fetchImpl,
    readToken: async () => token,
    now: () => CAPTURED_AT,
    baseUrl: 'https://api.example.test'
  })
}

describe('toClaudeUsage', () => {
  it('maps both windows, converting ISO resets_at to the contract epoch seconds', () => {
    expect(toClaudeUsage(API_RESPONSE, CAPTURED_AT)).toEqual({
      fiveHour: { usedPercent: 29, resetsAt: Math.floor(Date.parse(API_RESPONSE.five_hour.resets_at) / 1000) },
      sevenDay: { usedPercent: 6, resetsAt: Math.floor(Date.parse(API_RESPONSE.seven_day.resets_at) / 1000) },
      capturedAt: CAPTURED_AT
    })
  })

  it('keeps a fractional utilization unrounded, so the meter can use the exact width', () => {
    const raw = { five_hour: { utilization: 57.99999999999999, resets_at: '2026-08-24T22:00:00Z' } }
    expect(toClaudeUsage(raw, CAPTURED_AT)?.fiveHour?.usedPercent).toBe(57.99999999999999)
  })

  it('treats a window with a missing or unparseable resets_at as absent', () => {
    const raw = {
      five_hour: { utilization: 29 },
      seven_day: { utilization: 6, resets_at: 'not a timestamp' }
    }
    expect(toClaudeUsage(raw, CAPTURED_AT)).toBeNull()
  })

  it('reports the one readable window when the other is null (scoped-limit account)', () => {
    const raw = { five_hour: { utilization: 12, resets_at: '2026-08-24T22:00:00Z' }, seven_day: null }
    const mapped = toClaudeUsage(raw, CAPTURED_AT)
    expect(mapped?.fiveHour?.usedPercent).toBe(12)
    expect(mapped?.sevenDay).toBeNull()
  })

  it('returns null when neither window is readable (non-subscription account)', () => {
    expect(toClaudeUsage({ five_hour: null, seven_day: null }, CAPTURED_AT)).toBeNull()
    expect(toClaudeUsage({}, CAPTURED_AT)).toBeNull()
    expect(toClaudeUsage('nonsense', CAPTURED_AT)).toBeNull()
    expect(toClaudeUsage(null, CAPTURED_AT)).toBeNull()
  })
})

describe('createUsageApi', () => {
  it('queries the usage path with the bearer token and maps the response', async () => {
    const fetchImpl = okFetch(API_RESPONSE)
    const usage = await api(fetchImpl).fetchUsage()

    expect(usage?.fiveHour?.usedPercent).toBe(29)
    expect(usage?.capturedAt).toBe(CAPTURED_AT)

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.example.test${USAGE_API_PATH}`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-oauth-token')
  })

  it('caps the request, so a hung endpoint cannot leave the panel stuck busy', async () => {
    const fetchImpl = okFetch(API_RESPONSE)
    await api(fetchImpl).fetchUsage()

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns null (never throws) when the request is aborted by its timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError')
    }) as unknown as typeof fetch
    await expect(api(fetchImpl).fetchUsage()).resolves.toBeNull()
  })

  it('never issues a request when there is no token to use', async () => {
    const fetchImpl = okFetch(API_RESPONSE)
    expect(await api(fetchImpl, null).fetchUsage()).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null on a rejected request, so the caller keeps its existing snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch
    expect(await api(fetchImpl).fetchUsage()).toBeNull()
  })

  it('returns null (never throws) when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    await expect(api(fetchImpl).fetchUsage()).resolves.toBeNull()
  })

  it('returns null (never throws) when the response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })) as typeof fetch
    await expect(api(fetchImpl).fetchUsage()).resolves.toBeNull()
  })
})
