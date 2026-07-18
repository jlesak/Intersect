import type { AdoIdentity } from './adoMapping'

/**
 * Resolve who "I" am on Azure DevOps so sync can pick out the PRs I author or review. On-prem ADO
 * Server has no get_me profile endpoint, so the identity is derived from the PAT itself via the
 * connectionData endpoint, whose authenticatedUser carries the UUID that lets sync filter PRs
 * server-side. An explicit INTERSECT_ADO_IDENTITY override short-circuits the network call.
 */

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Classify a raw identity string (from the INTERSECT_ADO_IDENTITY override) as one of the three
 * shapes an ADO person carries: a UUID id, a `domain\user` uniqueName, or a bare display name.
 */
export function classifyIdentity(raw: string): AdoIdentity {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return { id: raw }
  if (raw.includes('\\')) return { uniqueName: raw }
  return { displayName: raw }
}

/**
 * Ask the server who a PAT authenticates as. connectionData is the one identity endpoint an on-prem
 * ADO Server exposes; its authenticatedUser.id is the UUID that enables the efficient server-side
 * PR filter. Throws when the server answers with anything but parseable JSON naming a user - an
 * unauthenticated on-prem request is answered with an HTML sign-in page under HTTP 200.
 */
export async function fetchConnectionIdentity(
  orgUrl: string,
  pat: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}
): Promise<AdoIdentity> {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = orgUrl.trim().replace(/\/+$/, '')
  const res = await fetchFn(`${base}/_apis/connectionData?api-version=7.0-preview.1`, {
    headers: { Authorization: `Basic ${Buffer.from(`:${pat.trim()}`).toString('base64')}` },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    throw new Error(`Azure DevOps rejected the identity lookup (HTTP ${res.status}).`)
  }
  let data: {
    authenticatedUser?: {
      id?: string
      uniqueName?: string
      providerDisplayName?: string
      customDisplayName?: string
    }
  }
  try {
    data = JSON.parse(await res.text()) as typeof data
  } catch {
    throw new Error(
      'Azure DevOps did not return an identity (received a sign-in page instead of data). Check the PAT.'
    )
  }
  const user = data.authenticatedUser
  const identity: AdoIdentity = {
    id: user?.id,
    uniqueName: user?.uniqueName,
    displayName: user?.customDisplayName || user?.providerDisplayName
  }
  if (!identity.id && !identity.uniqueName && !identity.displayName) {
    throw new Error('Azure DevOps did not return an identity for this PAT.')
  }
  return identity
}

export interface IdentityResolverDeps {
  /** Org URL + PAT for the connectionData lookup, resolved the same way the vote credentials are. */
  resolveCredentials: () => { orgUrl: string; pat: string }
  env?: NodeJS.ProcessEnv
  /** Injected in tests to fake the connectionData round-trip. */
  fetchFn?: typeof fetch
}

export interface IdentityResolver {
  /** Resolve the current identity, using the memoized result when one is cached. */
  resolve: () => Promise<AdoIdentity>
  /**
   * Drop the memoized identity so the next resolve re-derives it. Called when saved ADO settings
   * change, since a new account/PAT authenticates as a different person server-side.
   */
  invalidate: () => void
}

/**
 * A lazily-resolved, memoized identity. An explicit INTERSECT_ADO_IDENTITY override wins with no
 * network call; otherwise the PAT's own connectionData identity is used. The first successful
 * result is cached until invalidate() is called (on a saved-ADO-settings change) or the process
 * ends; a failed lookup is never cached, so a later call (after the VPN reconnects or the PAT is
 * fixed) can still succeed without a restart.
 */
export function createIdentityResolver(deps: IdentityResolverDeps): IdentityResolver {
  const env = deps.env ?? process.env
  let cached: AdoIdentity | null = null
  return {
    resolve: async () => {
      if (cached) return cached
      const override = env.INTERSECT_ADO_IDENTITY?.trim()
      if (override) {
        cached = classifyIdentity(override)
        return cached
      }
      const { orgUrl, pat } = deps.resolveCredentials()
      cached = await fetchConnectionIdentity(orgUrl, pat, { fetchFn: deps.fetchFn })
      return cached
    },
    invalidate: () => {
      cached = null
    }
  }
}
