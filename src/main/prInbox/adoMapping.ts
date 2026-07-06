import type { PrReviewer, PrRole, PrVote, PullRequest } from '@common/domain'

/**
 * Pure mappers from the Azure DevOps MCP server's raw JSON to Jarvis's domain types. Kept free of
 * any Electron / MCP-SDK import so they are unit-testable in the node vitest project.
 */

/** An ADO identity as it appears in createdBy / reviewers. Any subset of these may be present. */
export interface AdoPerson {
  id?: string
  displayName?: string
  uniqueName?: string
  vote?: number
  isRequired?: boolean
}

/** Who "I" am on this on-prem server, resolved from config (get_me is Services-only). */
export interface AdoIdentity {
  id?: string
  uniqueName?: string
  displayName?: string
}

export interface AdoRawPullRequest {
  pullRequestId: number
  title?: string
  description?: string
  status?: number | string
  creationDate?: string
  sourceRefName?: string
  targetRefName?: string
  url?: string
  createdBy?: AdoPerson
  reviewers?: AdoPerson[]
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } }
  lastMergeSourceCommit?: { commitId?: string }
  lastMergeTargetCommit?: { commitId?: string }
}

/** ADO reviewer vote code -> normalized vote. Unknown codes fall back to noVote. */
export function mapVote(code: number | undefined): PrVote {
  switch (code) {
    case 10:
      return 'approved'
    case 5:
      return 'approvedWithSuggestions'
    case -5:
      return 'waiting'
    case -10:
      return 'rejected'
    default:
      return 'noVote'
  }
}

/** ADO numeric PR status -> string. Already-string statuses pass through. */
export function mapStatus(status: number | string | undefined): string {
  if (typeof status === 'string') return status
  switch (status) {
    case 1:
      return 'active'
    case 2:
      return 'abandoned'
    case 3:
      return 'completed'
    default:
      return 'active'
  }
}

const lc = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

/**
 * Whether an ADO person is me. Matches by identity id first (most reliable), then the domain
 * uniqueName (e.g. `dmz\DZCUP4C`), then displayName - because on-prem Server has no get_me and the
 * identity is resolved from configuration.
 */
export function matchesIdentity(person: AdoPerson | undefined, identity: AdoIdentity): boolean {
  if (!person) return false
  if (identity.id && person.id && lc(identity.id) === lc(person.id)) return true
  if (identity.uniqueName && person.uniqueName && lc(identity.uniqueName) === lc(person.uniqueName))
    return true
  if (identity.displayName && person.displayName && lc(identity.displayName) === lc(person.displayName))
    return true
  return false
}

export function mapReviewer(raw: AdoPerson): PrReviewer {
  return {
    id: raw.id ?? '',
    displayName: raw.displayName ?? '',
    vote: mapVote(raw.vote),
    isRequired: raw.isRequired ?? false
  }
}

/** My role for a PR: author if I created it, else reviewer. Returns null if the PR is not mine. */
export function roleForIdentity(raw: AdoRawPullRequest, identity: AdoIdentity): PrRole | null {
  if (matchesIdentity(raw.createdBy, identity)) return 'author'
  if ((raw.reviewers ?? []).some((r) => matchesIdentity(r, identity))) return 'reviewer'
  return null
}

/** Map a raw PR to the domain type. `role` is the caller-resolved relationship. */
export function mapPullRequest(raw: AdoRawPullRequest, role: PrRole): PullRequest {
  const repo = raw.repository ?? {}
  return {
    prId: raw.pullRequestId,
    repositoryId: repo.id ?? '',
    repositoryName: repo.name ?? '',
    projectId: repo.project?.name ?? repo.project?.id ?? '',
    title: raw.title ?? '',
    authorId: raw.createdBy?.id ?? '',
    authorName: raw.createdBy?.displayName ?? '',
    createdAt: raw.creationDate ? Date.parse(raw.creationDate) : 0,
    status: mapStatus(raw.status),
    sourceRefName: raw.sourceRefName ?? '',
    targetRefName: raw.targetRefName ?? '',
    sourceCommitId: raw.lastMergeSourceCommit?.commitId ?? '',
    targetCommitId: raw.lastMergeTargetCommit?.commitId ?? '',
    url: raw.url ?? '',
    role,
    reviewers: (raw.reviewers ?? []).map(mapReviewer)
  }
}

/**
 * Merge the creator-filtered and reviewer-filtered fan-out results into one deduped list. A PR
 * present in both is kept once with role 'author' (author wins). Keyed by repositoryId + prId.
 */
export function mergeMyPrs(prs: PullRequest[]): PullRequest[] {
  const byKey = new Map<string, PullRequest>()
  for (const pr of prs) {
    const key = `${pr.repositoryId}:${pr.prId}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, pr)
    } else if (existing.role === 'reviewer' && pr.role === 'author') {
      byKey.set(key, pr)
    }
  }
  return [...byKey.values()]
}
