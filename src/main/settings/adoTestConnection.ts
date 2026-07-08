import type { AdoConnectionResult, AdoSettings } from '@common/domain'

/**
 * Verifies an Azure DevOps connection with the exact values the settings form holds (which may
 * differ from what is saved): first `connectionData` proves the org URL + PAT and names the
 * authenticated user, then - when both are filled in - the repository lookup proves the
 * project/repository exist under that org. Failure messages carry the HTTP status and the
 * server's response text but never the PAT.
 */

export interface TestConnectionOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function testAdoConnection(
  input: AdoSettings,
  opts: TestConnectionOptions = {}
): Promise<AdoConnectionResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const orgUrl = input.orgUrl.trim().replace(/\/+$/, '')
  const pat = input.pat.trim()
  if (!orgUrl || !pat) {
    return { ok: false, error: 'Organization URL and PAT are both required.' }
  }

  const request = (url: string): Promise<Response> =>
    fetchFn(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` },
      signal: AbortSignal.timeout(timeoutMs)
    })

  try {
    const conn = await request(`${orgUrl}/_apis/connectionData?api-version=7.0`)
    if (!conn.ok) {
      const detail = errorDetail(await conn.text().catch(() => ''))
      return {
        ok: false,
        error:
          conn.status === 401
            ? 'Azure DevOps rejected the PAT (HTTP 401).'
            : `Azure DevOps rejected the connection (HTTP ${conn.status})${detail ? `: ${detail}` : ''}`
      }
    }
    // An on-prem/TFS server can answer an invalid PAT with HTTP 200 and an HTML federated sign-in
    // page rather than a 401; a parseable JSON body is the only proof the PAT was truly accepted.
    const body = await conn.text()
    let data: {
      authenticatedUser?: { customDisplayName?: string; providerDisplayName?: string }
    }
    try {
      data = JSON.parse(body) as typeof data
    } catch {
      const detail = errorDetail(body)
      return {
        ok: false,
        error: detail
          ? `Azure DevOps rejected the PAT: ${detail}`
          : 'Azure DevOps rejected the PAT (received a sign-in page instead of data).'
      }
    }
    const displayName =
      data.authenticatedUser?.customDisplayName ||
      data.authenticatedUser?.providerDisplayName ||
      'unknown user'

    const project = input.project.trim()
    const repository = input.repository.trim()
    if (project && repository) {
      const repo = await request(
        `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/` +
          `${encodeURIComponent(repository)}?api-version=7.0`
      )
      if (!repo.ok) {
        if (repo.status === 404) {
          return {
            ok: false,
            error: `Project "${project}" or repository "${repository}" was not found.`
          }
        }
        const detail = errorDetail(await repo.text().catch(() => ''))
        return {
          ok: false,
          error: `Azure DevOps rejected the repository lookup (HTTP ${repo.status})${detail ? `: ${detail}` : ''}`
        }
      }
    }

    return { ok: true, displayName }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, error: `Azure DevOps did not answer within ${timeoutMs / 1000}s.` }
    }
    return {
      ok: false,
      error: `Could not reach Azure DevOps: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * The on-prem server answers some failures (notably auth) with a full HTML page; showing doctype
 * and CSS inline helps nobody, but the page title carries the actual TF error code.
 */
function errorDetail(body: string): string {
  const text = body.replace(/^\uFEFF/, '').trim()
  if (text.startsWith('<')) {
    const title = /<title>([^<]*)<\/title>/i.exec(text)
    return (title?.[1] ?? '').trim().slice(0, 200)
  }
  return text.slice(0, 500)
}
