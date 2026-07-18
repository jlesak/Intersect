import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JIRA_HOST } from './jiraMapping'

/**
 * A usable Jira SSO session, distilled from the jira skill's browser-captured storage state:
 * the Cookie header value carrying every cookie scoped to the Jira host. No token of any kind
 * is involved - the session is exactly what the browser login saved.
 */
export interface JiraSession {
  cookieHeader: string
}

/** Where the jira skill's interactive login persists the browser storage state. */
export function jiraStorageStatePath(): string {
  return join(homedir(), '.claude', 'jira', 'storageState.json')
}

interface StoredCookie {
  name: string
  value: string
  domain?: string
}

/**
 * Build the Cookie header for the given host from a parsed Playwright storage state. Cookies
 * match when their domain (leading dot stripped) is the host itself or a parent domain of it.
 * Returns null when no cookie applies - there is no session to speak of.
 */
export function sessionFromStorageState(state: unknown, host: string = JIRA_HOST): JiraSession | null {
  const cookies = ((state as { cookies?: StoredCookie[] })?.cookies ?? []).filter((c) => {
    const domain = (c.domain ?? '').replace(/^\./, '')
    return domain === host || (domain !== '' && host.endsWith('.' + domain))
  })
  if (cookies.length === 0) return null
  return { cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; ') }
}

/**
 * Read the saved SSO session from the storage-state file. Returns null when the file is missing,
 * unreadable, or carries no cookie for the host - all of which mean a login is needed.
 */
export async function readStorageStateSession(
  statePath: string = jiraStorageStatePath(),
  host: string = JIRA_HOST
): Promise<JiraSession | null> {
  try {
    return sessionFromStorageState(JSON.parse(await readFile(statePath, 'utf8')), host)
  } catch {
    return null
  }
}
