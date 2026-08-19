import type { PrThread, PrVote, PullRequest } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'
import type { Logger } from '@common/logging/logger'
import type { AdoClient } from './adoClient'
import {
  mapPullRequest,
  mergeMyPrs,
  roleForIdentity,
  type AdoIdentity,
  type AdoPerson,
  type AdoRawPullRequest
} from './adoMapping'
import { castVote as castVoteRest, type CastVoteOptions } from './adoVote'

const PAGE_SIZE = 100

interface ListResult {
  count?: number
  value?: AdoRawPullRequest[]
  hasMoreResults?: boolean
}

interface RepositoryRef {
  id?: string
  name?: string
}

/**
 * Azure DevOps' Git REST API returns collection responses as `{ count, value }`. The default MCP
 * server currently unwraps that to an array, but configured server implementations are allowed to
 * pass the REST payload through unchanged, so tolerate both representations at this boundary.
 */
type ListRepositoriesResult = RepositoryRef[] | { value?: RepositoryRef[] }

export interface AdoServiceDeps {
  client: AdoClient
  /**
   * Who I am on the ADO server. Resolved lazily (and possibly over the network, via connectionData)
   * so a configuration problem surfaces at sync time, not at boot.
   */
  resolveIdentity: () => Promise<AdoIdentity>
  /** Resolved lazily per call so a project changed in Settings applies without a restart. */
  projectId: () => string
  /**
   * The last-known unresolved thread count for a PR, read from the cache. Used to preserve the
   * board's author-side signal when a single PR's thread fetch fails mid-sync, instead of
   * clobbering the persisted count with 0.
   */
  priorThreadCount: (repositoryId: string, prId: number) => number
  /**
   * The last-known activity timestamp for a PR, read from the cache. Used so a single PR's failed
   * thread fetch cannot drop that card to the bottom of an activity-ordered column.
   */
  priorActivityAt: (repositoryId: string, prId: number) => number
  /** Org URL + PAT for the direct REST vote call, resolved lazily per vote (see adoVote). */
  resolveVoteCredentials: () => { orgUrl: string; pat: string }
  /** Injected in tests to fake the vote HTTP round-trip. */
  voteOptions?: CastVoteOptions
  /**
   * Diagnostic surface for the two partial outcomes a sync tolerates. Optional so tests can
   * construct the service without one; production always supplies it.
   */
  logger?: Logger
}

export interface SyncResult {
  prs: PullRequest[]
  failedRepos: string[]
}

export interface AdoService {
  syncMyPrs(): Promise<SyncResult>
  getThreads(repositoryId: string, prId: number): Promise<PrThread[]>
  /**
   * Post a new comment thread; null filePath/line anchors it to the PR itself. Resolves with the
   * created thread id, or with null when the write succeeded but the server's answer carried no
   * readable id. Rejects only when the comment did not reach Azure DevOps, so a caller may treat a
   * rejection as "nothing was posted" and safely offer a retry.
   */
  publishComment(input: {
    repositoryId: string
    prId: number
    filePath: string | null
    line: number | null
    body: string
  }): Promise<number | null>
  /** Post a reply into an existing thread, immediately and under my identity. */
  replyToThread(input: {
    repositoryId: string
    prId: number
    threadId: number
    body: string
  }): Promise<void>
  /** Resolve or reactivate a thread. */
  setThreadStatus(input: {
    repositoryId: string
    prId: number
    threadId: number
    status: 'active' | 'fixed'
  }): Promise<void>
  /** Cast my reviewer vote on the PR, addressed by my reviewer entry id. */
  castVote(repositoryId: string, prId: number, reviewerId: string, vote: PrVote): Promise<void>
}

export function createAdoService(d: AdoServiceDeps): AdoService {
  function repositoriesFrom(result: ListRepositoriesResult): RepositoryRef[] {
    if (Array.isArray(result)) return result
    if (Array.isArray(result.value)) return result.value
    throw new Error('Azure DevOps list_repositories returned no repository list')
  }

  /** Page through list_pull_requests, applying an optional identity filter, collecting all pages. */
  async function listAll(
    repositoryId: string,
    filter: { creatorId?: string; reviewerId?: string }
  ): Promise<AdoRawPullRequest[]> {
    const out: AdoRawPullRequest[] = []
    let skip = 0
    // Hard page cap so a server that ignores `skip` cannot spin this forever (5000 active PRs).
    for (let page = 0; page < 50; page++) {
      const result = await d.client.callTool<ListResult>('list_pull_requests', {
        repositoryId,
        projectId: d.projectId(),
        status: 'active',
        top: PAGE_SIZE,
        skip,
        ...filter
      })
      const batch = result.value ?? []
      out.push(...batch)
      if (batch.length < PAGE_SIZE || result.hasMoreResults === false) break
      skip += PAGE_SIZE
    }
    return out
  }

  /** One PR's comment threads, shared by getThreads and the sync's thread-count enrichment. */
  async function fetchThreads(repositoryId: string, prId: number): Promise<PrThread[]> {
    const raw = await d.client.callTool<{ value?: RawThread[] } | RawThread[]>(
      'get_pull_request_comments',
      { repositoryId, pullRequestId: prId, projectId: d.projectId() }
    )
    const threads = Array.isArray(raw) ? raw : (raw.value ?? [])
    return threads.map(toThread)
  }

  /** All my PRs in one repo. Uses server-side filters when my UUID is known, else client-filters. */
  async function repoPrs(repositoryId: string, identity: AdoIdentity): Promise<PullRequest[]> {
    if (identity.id) {
      const [authored, reviewing] = await Promise.all([
        listAll(repositoryId, { creatorId: identity.id }),
        listAll(repositoryId, { reviewerId: identity.id })
      ])
      return mergeMyPrs([
        ...authored.map((raw) => mapPullRequest(raw, 'author', identity)),
        ...reviewing.map((raw) => mapPullRequest(raw, 'reviewer', identity))
      ])
    }
    // No UUID (identity is a name/uniqueName): list all active PRs and match client-side.
    const all = await listAll(repositoryId, {})
    const mine: PullRequest[] = []
    for (const raw of all) {
      const role = roleForIdentity(raw, identity)
      if (role) mine.push(mapPullRequest(raw, role, identity))
    }
    return mine
  }

  return {
    async syncMyPrs() {
      const identity = await d.resolveIdentity()
      const result = await d.client.callTool<ListRepositoriesResult>(
        'list_repositories',
        { projectId: d.projectId() }
      )
      const repos = repositoriesFrom(result)
      const settled = await Promise.allSettled(
        repos.map(async (r) => ({
          name: r.name ?? r.id ?? '?',
          prs: await repoPrs(r.name ?? r.id ?? '', identity)
        }))
      )

      const prs: PullRequest[] = []
      const failedRepos: string[] = []
      let anySucceeded = false
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          anySucceeded = true
          prs.push(...res.value.prs)
        } else {
          failedRepos.push(repos[i]?.name ?? repos[i]?.id ?? '?')
        }
      })

      if (!anySucceeded) {
        throw new Error(`Sync failed for every repository: ${failedRepos.join(', ')}`)
      }
      const merged = mergeMyPrs(prs)
      // Thread counts feed the board's author-side "needs my action" signal, and the newest
      // comment across all threads dates the PR for an activity-ordered queue. One PR's failure
      // must not fail the sync; carry that PR's last-known values forward so a transient thread
      // fetch neither clears the board signal nor moves the card until the next successful sync.
      const enriched = await Promise.all(
        merged.map(async (pr) => {
          try {
            const threads = await fetchThreads(pr.repositoryId, pr.prId)
            const count = threads.filter((t) => !t.isSystem && isThreadUnresolved(t)).length
            return { ...pr, activeThreadCount: count, lastActivityAt: lastActivity(pr, threads) }
          } catch (err) {
            d.logger?.warn('pull request thread fetch failed', {
              data: { prId: pr.prId, repository: pr.repositoryName },
              err
            })
            return {
              ...pr,
              activeThreadCount: d.priorThreadCount(pr.repositoryId, pr.prId),
              lastActivityAt: Math.max(pr.createdAt, d.priorActivityAt(pr.repositoryId, pr.prId))
            }
          }
        })
      )
      return { prs: enriched, failedRepos }
    },

    async getThreads(repositoryId, prId) {
      return fetchThreads(repositoryId, prId)
    },

    async publishComment(input) {
      // Widened past the success shape on purpose: the client hands back a bare string for a body
      // it could not parse and undefined for an empty one, and both reach this call in practice.
      const res: AddCommentResult | string | undefined = await d.client.callTool<AddCommentResult>(
        'add_pull_request_comment',
        {
          pullRequestId: input.prId,
          repositoryId: input.repositoryId,
          projectId: d.projectId(),
          content: input.body,
          ...(input.filePath !== null ? { filePath: input.filePath } : {}),
          ...(input.line !== null ? { lineNumber: input.line } : {}),
          status: 'active'
        }
      )

      // Azure DevOps reports a rejected write as plain text carrying no error flag, so a refusal
      // arrives here as a string and an empty body as undefined. Both mean the comment never
      // reached the pull request, and rejecting is what returns the draft to pending so the author
      // sees the reason and can retry.
      if (typeof res !== 'object' || res === null) {
        throw new Error(`Azure DevOps rejected the comment: ${res || 'the response was empty'}`)
      }

      // Creating a thread answers with the created comment beside the created thread, so the id
      // lives under `thread`. The flat fallbacks cover a server that hands back the thread itself.
      const threadId = res.thread?.id ?? res.id ?? res.threadId
      if (typeof threadId === 'number') return threadId

      // An object carrying neither half of a creation is an answer to something other than the
      // write succeeding, so it gets the same treatment as a refusal.
      if (!res.thread && !res.comment) {
        throw new Error('Azure DevOps returned no created thread for the comment')
      }

      // The comment IS live on the pull request at this point, so this is bookkeeping loss over a
      // failed write. Reporting it as a failure would send the caller into a retry that posts a
      // duplicate.
      d.logger?.warn('published comment came back without a thread id', {
        data: { prId: input.prId, repositoryId: input.repositoryId }
      })
      return null
    },

    async replyToThread(input) {
      await d.client.callTool('add_pull_request_comment', {
        pullRequestId: input.prId,
        repositoryId: input.repositoryId,
        projectId: d.projectId(),
        threadId: input.threadId,
        content: input.body
      })
    },

    async setThreadStatus(input) {
      await d.client.callTool('update_pull_request_thread_status', {
        pullRequestId: input.prId,
        repositoryId: input.repositoryId,
        projectId: d.projectId(),
        threadId: input.threadId,
        status: input.status
      })
    },

    async castVote(repositoryId, prId, reviewerId, vote) {
      const { orgUrl, pat } = d.resolveVoteCredentials()
      await castVoteRest(
        { orgUrl, pat, projectId: d.projectId(), repositoryId, prId, reviewerId, vote },
        d.voteOptions ?? {}
      )
    }
  }
}

/**
 * When this pull request was last touched: the newest comment on any of its threads, or its own
 * creation when nothing is newer. System threads count, because Azure DevOps records pushes, vote
 * changes and policy evaluations as system comments and those are real activity on a review queue.
 * Creation is the floor, so a comment whose publish date was missing (mapped to 0) cannot backdate
 * a pull request to 1970.
 */
function lastActivity(pr: PullRequest, threads: PrThread[]): number {
  let newest = pr.createdAt
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (comment.publishedAt > newest) newest = comment.publishedAt
    }
  }
  return newest
}

// --- raw ADO shapes + defensive mappers -------------------------------------

/**
 * What `add_pull_request_comment` answers when it opens a new thread: the created comment next to
 * the created thread. The flat `RawThread` fields are kept as a fallback for a server variant that
 * returns the thread unwrapped.
 */
interface AddCommentResult extends RawThread {
  thread?: RawThread
  comment?: { id?: number }
}

interface RawThread {
  id?: number
  threadId?: number
  status?: string | number
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } }
  comments?: Array<{
    author?: AdoPerson
    content?: string
    publishedDate?: string
    commentType?: string
  }>
}

/** ADO wire codes for thread status; string statuses pass through unchanged. */
const THREAD_STATUS_BY_CODE: Record<number, string> = {
  1: 'active',
  2: 'fixed',
  3: 'wontFix',
  4: 'closed',
  5: 'byDesign',
  6: 'pending'
}

function toThread(raw: RawThread): PrThread {
  const comments = raw.comments ?? []
  return {
    threadId: raw.id ?? raw.threadId ?? 0,
    filePath: raw.threadContext?.filePath ?? null,
    line: raw.threadContext?.rightFileStart?.line ?? null,
    status:
      typeof raw.status === 'number'
        ? (THREAD_STATUS_BY_CODE[raw.status] ?? String(raw.status))
        : (raw.status ?? 'unknown'),
    // ADO marks housekeeping comments (vote changes, policy updates) with a non-text commentType.
    isSystem: comments.length > 0 && comments.every((c) => (c.commentType ?? 'text') !== 'text'),
    comments: comments.map((c) => ({
      authorName: c.author?.displayName ?? '',
      body: c.content ?? '',
      publishedAt: c.publishedDate ? Date.parse(c.publishedDate) : 0
    }))
  }
}
