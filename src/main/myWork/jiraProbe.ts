import { readFile } from 'node:fs/promises'

/**
 * Whether the jira skill's saved SSO session currently works: `auth` means login is definitely
 * needed (no saved session, or Jira rejected/redirected it), `unknown` means the probe could not
 * tell (network hiccup) and the fetch should proceed as if logged in.
 */
export type JiraProbeResult = 'ok' | 'auth' | 'unknown'

const JIRA_HOST = 'jira.skoda.vwgroup.com'
const PROBE_URL = `https://${JIRA_HOST}/rest/api/2/myself`
const PROBE_TIMEOUT_MS = 5_000

interface StoredCookie {
  name: string
  value: string
  domain?: string
}

/**
 * A sub-second direct check of the saved SSO session against Jira, so an expired or missing login
 * is detected immediately instead of after a whole hidden Claude session round-trip. Uses the same
 * browser-captured cookies as the jira skill; no token of any kind is involved.
 */
export async function probeJiraSession(
  statePath: string,
  fetchFn: typeof fetch = fetch
): Promise<JiraProbeResult> {
  let cookieHeader: string
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { cookies?: StoredCookie[] }
    const cookies = (state.cookies ?? []).filter((c) => {
      const domain = (c.domain ?? '').replace(/^\./, '')
      return domain === JIRA_HOST || (domain && JIRA_HOST.endsWith('.' + domain))
    })
    if (cookies.length === 0) return 'auth'
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    // No saved session file (or an unreadable one): login is needed.
    return 'auth'
  }

  try {
    const response = await fetchFn(PROBE_URL, {
      headers: { Accept: 'application/json', Cookie: cookieHeader },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    // The SSO front sends an expired session to the IdP via a redirect; Jira itself answers 401/403.
    if (response.status >= 300 && response.status < 400) return 'auth'
    if (response.status === 401 || response.status === 403) return 'auth'
    if (response.ok && (response.headers.get('content-type') ?? '').includes('application/json')) {
      return 'ok'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
