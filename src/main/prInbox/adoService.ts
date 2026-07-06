import type { FileDiff, PrChangeFile, PrThread, PullRequest } from '@common/domain'
import type { AdoClient } from './adoClient'
import {
  mapPullRequest,
  mergeMyPrs,
  roleForIdentity,
  type AdoIdentity,
  type AdoPerson,
  type AdoRawPullRequest
} from './adoMapping'
import { langFromPath } from './language'

const PAGE_SIZE = 100
const MAX_DIFF_BYTES = 512 * 1024

interface ListResult {
  count?: number
  value?: AdoRawPullRequest[]
  hasMoreResults?: boolean
}

export interface AdoServiceDeps {
  client: AdoClient
  /** Resolved lazily so a missing INTERSECT_ADO_IDENTITY surfaces at sync time, not at boot. */
  resolveIdentity: () => AdoIdentity
  projectId: string
}

export interface SyncResult {
  prs: PullRequest[]
  failedRepos: string[]
}

export interface AdoService {
  syncMyPrs(): Promise<SyncResult>
  getChanges(repositoryId: string, prId: number): Promise<PrChangeFile[]>
  getFileDiff(input: {
    repositoryId: string
    filePath: string
    originalPath: string | null
    sourceCommit: string
    targetCommit: string
    changeType: PrChangeFile['changeType']
  }): Promise<FileDiff>
  getThreads(repositoryId: string, prId: number): Promise<PrThread[]>
  publishComment(input: {
    repositoryId: string
    prId: number
    filePath: string
    line: number
    body: string
  }): Promise<number>
}

export function createAdoService(d: AdoServiceDeps): AdoService {
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
        projectId: d.projectId,
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

  /** All my PRs in one repo. Uses server-side filters when my UUID is known, else client-filters. */
  async function repoPrs(repositoryId: string, identity: AdoIdentity): Promise<PullRequest[]> {
    if (identity.id) {
      const [authored, reviewing] = await Promise.all([
        listAll(repositoryId, { creatorId: identity.id }),
        listAll(repositoryId, { reviewerId: identity.id })
      ])
      return mergeMyPrs([
        ...authored.map((raw) => mapPullRequest(raw, 'author')),
        ...reviewing.map((raw) => mapPullRequest(raw, 'reviewer'))
      ])
    }
    // No UUID (identity is a name/uniqueName): list all active PRs and match client-side.
    const all = await listAll(repositoryId, {})
    const mine: PullRequest[] = []
    for (const raw of all) {
      const role = roleForIdentity(raw, identity)
      if (role) mine.push(mapPullRequest(raw, role))
    }
    return mine
  }

  return {
    async syncMyPrs() {
      const identity = d.resolveIdentity()
      const repos = await d.client.callTool<Array<{ id?: string; name?: string }>>(
        'list_repositories',
        { projectId: d.projectId }
      )
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
      return { prs: mergeMyPrs(prs), failedRepos }
    },

    async getChanges(repositoryId, prId) {
      const res = await d.client.callTool<{ files?: RawChangeFile[]; changes?: RawChangeFile[] }>(
        'get_pull_request_changes',
        { repositoryId, pullRequestId: prId, projectId: d.projectId }
      )
      const files = res.files ?? res.changes ?? []
      return files.map(toChangeFile)
    },

    async getFileDiff(input) {
      const modified =
        input.changeType === 'delete'
          ? ''
          : await fetchContent(d, input.repositoryId, input.filePath, input.sourceCommit)
      const original =
        input.changeType === 'add'
          ? ''
          : await fetchContent(
              d,
              input.repositoryId,
              input.originalPath ?? input.filePath,
              input.targetCommit
            )

      const binary = isBinary(original) || isBinary(modified)
      const tooLarge = byteLen(original) > MAX_DIFF_BYTES || byteLen(modified) > MAX_DIFF_BYTES
      return {
        path: input.filePath,
        original: binary || tooLarge ? '' : original,
        modified: binary || tooLarge ? '' : modified,
        language: langFromPath(input.filePath),
        binary,
        tooLarge
      }
    },

    async getThreads(repositoryId, prId) {
      const raw = await d.client.callTool<{ value?: RawThread[] } | RawThread[]>(
        'get_pull_request_comments',
        { repositoryId, pullRequestId: prId, projectId: d.projectId }
      )
      const threads = Array.isArray(raw) ? raw : (raw.value ?? [])
      return threads.map(toThread)
    },

    async publishComment(input) {
      const res = await d.client.callTool<RawThread>('add_pull_request_comment', {
        pullRequestId: input.prId,
        repositoryId: input.repositoryId,
        projectId: d.projectId,
        content: input.body,
        filePath: input.filePath,
        lineNumber: input.line,
        status: 'active'
      })
      const threadId = res?.id ?? res?.threadId
      if (typeof threadId !== 'number') {
        throw new Error('Azure DevOps did not return a thread id for the published comment')
      }
      return threadId
    }
  }
}

// --- raw ADO shapes + defensive mappers -------------------------------------

interface RawChangeFile {
  path?: string
  changeType?: string
  originalPath?: string
  sourceServerItem?: string
  item?: { path?: string }
}

function toChangeFile(raw: RawChangeFile): PrChangeFile {
  const path = raw.path ?? raw.item?.path ?? ''
  const ct = (raw.changeType ?? '').toLowerCase()
  const changeType: PrChangeFile['changeType'] = ct.includes('add')
    ? 'add'
    : ct.includes('delete')
      ? 'delete'
      : ct.includes('rename')
        ? 'rename'
        : 'edit'
  return { path, changeType, originalPath: raw.originalPath ?? raw.sourceServerItem ?? null }
}

interface RawThread {
  id?: number
  threadId?: number
  status?: string | number
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } }
  comments?: Array<{ author?: AdoPerson; content?: string; publishedDate?: string }>
}

function toThread(raw: RawThread): PrThread {
  return {
    threadId: raw.id ?? raw.threadId ?? 0,
    filePath: raw.threadContext?.filePath ?? null,
    line: raw.threadContext?.rightFileStart?.line ?? null,
    status: typeof raw.status === 'number' ? String(raw.status) : (raw.status ?? 'unknown'),
    comments: (raw.comments ?? []).map((c) => ({
      authorName: c.author?.displayName ?? '',
      body: c.content ?? '',
      publishedAt: c.publishedDate ? Date.parse(c.publishedDate) : 0
    }))
  }
}

async function fetchContent(
  d: AdoServiceDeps,
  repositoryId: string,
  path: string,
  commit: string
): Promise<string> {
  try {
    const res = await d.client.callTool<{ content?: string } | string>('get_file_content', {
      repositoryId,
      projectId: d.projectId,
      path,
      version: commit,
      versionType: 'commit'
    })
    if (typeof res === 'string') return res
    return res.content ?? ''
  } catch (err) {
    // Only a genuine "file not present at this version" is a legitimately empty side. Any other
    // failure (timeout, auth, transient) must surface, not silently render a wrong (all-added or
    // all-deleted) diff during a review.
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found|404|does not exist|could not be found|no such|TF401174/i.test(msg)) return ''
    throw err
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Heuristic: a NUL character in the first chunk means the file is binary. */
function isBinary(s: string): boolean {
  const head = s.slice(0, 8000)
  for (let i = 0; i < head.length; i++) {
    if (head.charCodeAt(i) === 0) return true
  }
  return false
}
