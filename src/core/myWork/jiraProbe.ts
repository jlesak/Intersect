import { JIRA_BASE_URL } from './jiraMapping'
import { readStorageStateSession } from './jiraSession'

/**
 * Whether the jira skill's saved SSO session currently works: `auth` means login is definitely
 * needed (no saved session, or Jira rejected/redirected it), `unknown` means the probe could not
 * tell (network hiccup) and the fetch should proceed as if logged in.
 */
export type JiraProbeResult = 'ok' | 'auth' | 'unknown'

const PROBE_URL = `${JIRA_BASE_URL}/rest/api/2/myself`
const PROBE_TIMEOUT_MS = 5_000

/**
 * A sub-second direct check of the saved SSO session against Jira, so an expired or missing login
 * is detected immediately instead of after a whole hidden Claude session round-trip. Uses the same
 * browser-captured cookies as the jira skill; no token of any kind is involved.
 */
export async function probeJiraSession(
  statePath: string,
  fetchFn: typeof fetch = fetch
): Promise<JiraProbeResult> {
  const session = await readStorageStateSession(statePath)
  // No saved session (or an unreadable one): login is needed.
  if (!session) return 'auth'

  try {
    const response = await fetchFn(PROBE_URL, {
      headers: { Accept: 'application/json', Cookie: session.cookieHeader },
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
