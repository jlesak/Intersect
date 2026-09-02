import type { ClaudeUsage, ClaudeUsageWindow } from '@common/domain'

/** Anthropic's own host, the only place the OAuth token is ever sent. */
export const USAGE_API_BASE_URL = 'https://api.anthropic.com'

/** Path returning the signed-in account's current rate-limit utilization. */
export const USAGE_API_PATH = '/api/oauth/usage'

/**
 * Caps how long one live query may hang. The refresh button disables itself for the duration, so
 * a request that never settles would leave the panel stuck busy with no way back.
 */
export const USAGE_TIMEOUT_MS = 8000

export interface UsageApiDeps {
  fetch: typeof fetch
  /** Claude Code's live OAuth access token, or null when there is none to use. */
  readToken(): Promise<string | null>
  now(): number
  baseUrl?: string
}

export interface UsageApi {
  /** Query the live usage, or null when it could not be obtained. Never throws. */
  fetchUsage(): Promise<ClaudeUsage | null>
}

/** One window as the API returns it: a percentage plus an ISO-8601 reset timestamp. */
interface RawApiWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface RawApiUsage {
  five_hour?: RawApiWindow | null
  seven_day?: RawApiWindow | null
}

/**
 * Maps one API window onto the app's contract. The API reports `resets_at` as an ISO-8601 string
 * while the contract (set by Claude Code's statusline JSON) carries epoch seconds, so the two
 * sources stay directly comparable once converted.
 */
function toWindow(raw: RawApiWindow | null | undefined): ClaudeUsageWindow | null {
  if (!raw || typeof raw.utilization !== 'number' || typeof raw.resets_at !== 'string') return null
  const resetsAtMs = Date.parse(raw.resets_at)
  if (!Number.isFinite(resetsAtMs)) return null
  return { usedPercent: raw.utilization, resetsAt: Math.floor(resetsAtMs / 1000) }
}

/**
 * Maps the usage response onto the app's snapshot contract, tolerating any shape. The response
 * carries many more windows than the two the panel shows (per-model weekly scopes, extra-usage
 * credits); those are ignored on purpose, so a new field appearing upstream changes nothing here.
 * Returns null only when neither window could be read at all, which is what a non-subscription
 * account looks like.
 */
export function toClaudeUsage(raw: unknown, capturedAt: number): ClaudeUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as RawApiUsage
  const fiveHour = toWindow(usage.five_hour)
  const sevenDay = toWindow(usage.seven_day)
  if (!fiveHour && !sevenDay) return null
  return { fiveHour, sevenDay, capturedAt }
}

/**
 * Reads the signed-in account's live rate-limit usage straight from Anthropic, using the OAuth
 * token Claude Code already holds. This is the only source that reflects usage from every Claude
 * session on the machine (and every other machine on the account) rather than only the sessions
 * this app launched, and the only one that can be refreshed on demand.
 *
 * The endpoint is undocumented and can change or disappear without notice, so every failure -
 * no token, a rejected request, a request that outran its timeout, an unexpected payload - resolves
 * to null and leaves the caller on whatever snapshot it already had.
 */
export function createUsageApi(deps: UsageApiDeps): UsageApi {
  const baseUrl = deps.baseUrl ?? USAGE_API_BASE_URL

  return {
    async fetchUsage() {
      const token = await deps.readToken()
      if (!token) return null
      try {
        const response = await deps.fetch(`${baseUrl}${USAGE_API_PATH}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'anthropic-version': '2023-06-01',
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
        })
        if (!response.ok) return null
        return toClaudeUsage(await response.json(), deps.now())
      } catch {
        return null
      }
    }
  }
}
