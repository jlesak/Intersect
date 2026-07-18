import type { PrVote } from '@common/domain'
import { toNumericVote } from './adoMapping'

/**
 * Casting a reviewer vote is the one Azure DevOps write the MCP server does not offer, so it goes
 * straight to the REST API: a PUT on the PR's reviewer resource, authenticated with the same PAT
 * the MCP server spawn uses. Failure messages carry the HTTP status and the server's response text
 * but never the PAT.
 */

export interface CastVoteRequest {
  /** Collection/organization base URL, e.g. `https://devops.example.com/tfs/DefaultCollection`. */
  orgUrl: string
  pat: string
  projectId: string
  repositoryId: string
  prId: number
  reviewerId: string
  vote: PrVote
}

export interface CastVoteOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function castVote(req: CastVoteRequest, opts: CastVoteOptions = {}): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch
  const base = req.orgUrl.replace(/\/+$/, '')
  const url =
    `${base}/${encodeURIComponent(req.projectId)}/_apis/git/repositories/` +
    `${encodeURIComponent(req.repositoryId)}/pullRequests/${req.prId}/reviewers/` +
    `${encodeURIComponent(req.reviewerId)}?api-version=7.0`

  const response = await fetchFn(url, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${Buffer.from(`:${req.pat}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ vote: toNumericVote(req.vote) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })

  if (!response.ok) {
    const detail = errorDetail(await response.text().catch(() => ''))
    throw new Error(
      `Azure DevOps rejected the vote (HTTP ${response.status})${detail ? `: ${detail}` : ''}`
    )
  }
}

/**
 * The on-prem server answers some failures (notably auth) with a full HTML page; showing doctype
 * and CSS in a toast helps nobody, but the page title carries the actual TF error code.
 */
function errorDetail(body: string): string {
  const text = body.replace(/^\uFEFF/, '').trim()
  if (text.startsWith('<')) {
    const title = /<title>([^<]*)<\/title>/i.exec(text)
    return (title?.[1] ?? '').trim().slice(0, 200)
  }
  return text.slice(0, 500)
}
