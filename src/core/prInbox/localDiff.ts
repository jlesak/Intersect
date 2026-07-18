import type { FileDiff, PrChangeFile, PullRequest } from '@common/domain'
import { git, gitRaw, gitWithLockRetry } from './git'
import { langFromPath } from './language'

/** Diffs larger than this (either side) render a placeholder instead of the full text. */
const MAX_DIFF_BYTES = 512 * 1024

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

/**
 * Map a `git diff --name-status` status letter to our change type. `R`/`C` carry a similarity score
 * (e.g. `R096`); only the leading letter matters here.
 */
function changeTypeOf(status: string): PrChangeFile['changeType'] {
  const letter = status[0]
  if (letter === 'A') return 'add'
  if (letter === 'D') return 'delete'
  if (letter === 'R') return 'rename'
  return 'edit'
}

/**
 * Parse the tab-delimited `--name-status -M` output into change records. Paths are normalized to the
 * Azure DevOps convention used everywhere else in the PR pipeline (leading slash), so thread
 * matching, comment badges, and draft publishing all key off the same shape.
 */
export function parseNameStatus(raw: string): PrChangeFile[] {
  const changes: PrChangeFile[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [status, ...paths] = line.split('\t')
    const changeType = changeTypeOf(status)
    if (changeType === 'rename') {
      const [originalPath, path] = paths
      changes.push({ path: `/${path}`, changeType, originalPath: `/${originalPath}` })
    } else {
      changes.push({ path: `/${paths[0]}`, changeType, originalPath: null })
    }
  }
  return changes
}

/**
 * The PR's changed files, computed locally against the merge base of target and source (three-dot),
 * so target-side changes not part of the PR are excluded - matching the Azure DevOps web diff.
 */
export async function localChanges(
  repoDir: string,
  targetCommit: string,
  sourceCommit: string
): Promise<PrChangeFile[]> {
  const raw = await git(repoDir, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--merge-base',
    '--name-status',
    '-M',
    targetCommit,
    sourceCommit
  ])
  return parseNameStatus(raw)
}

export interface FileDiffInput {
  targetCommit: string
  sourceCommit: string
  filePath: string
  originalPath: string | null
  changeType: PrChangeFile['changeType']
}

/** Thrown by showBlob when a blob exceeds gitRaw's maxBuffer, so localFileDiff can flag it oversize. */
const BLOB_TOO_LARGE = Symbol('blob-too-large')

/** True when a git failure is Node's maxBuffer-exceeded error (blob larger than gitRaw's cap). */
function isMaxBufferError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true
    return /maxBuffer/i.test(err.message)
  }
  return false
}

/**
 * Read a blob at `commit:path`. A path that genuinely does not exist at that revision is a
 * legitimately-empty side (the file was added or deleted), so it returns ''. A blob larger than
 * gitRaw's maxBuffer throws the BLOB_TOO_LARGE sentinel so the caller can render the oversize
 * placeholder. Every other git failure (bad revision, unfetched commit, transient error) is rethrown
 * rather than masked as an empty side, so a wrong all-added/all-deleted diff is never shown during a
 * review.
 */
async function showBlob(repoDir: string, commit: string, path: string): Promise<string> {
  return gitRaw(repoDir, ['show', `${commit}:${path}`]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (/does not exist in|exists on disk, but not in/.test(msg)) return ''
    if (isMaxBufferError(err)) throw BLOB_TOO_LARGE
    throw err
  })
}

/**
 * Both sides of one changed file, read locally. The left side is the merge base of target and
 * source (three-dot), so it reflects the PR's baseline rather than the target tip. Binary or
 * oversize content is withheld and flagged for a placeholder.
 */
export async function localFileDiff(repoDir: string, input: FileDiffInput): Promise<FileDiff> {
  const mergeBase = await git(repoDir, ['merge-base', input.targetCommit, input.sourceCommit])
  const gitPath = (p: string): string => p.replace(/^\//, '')
  let original: string
  let modified: string
  try {
    original =
      input.changeType === 'add'
        ? ''
        : await showBlob(repoDir, mergeBase, gitPath(input.originalPath ?? input.filePath))
    modified =
      input.changeType === 'delete'
        ? ''
        : await showBlob(repoDir, input.sourceCommit, gitPath(input.filePath))
  } catch (err) {
    if (err === BLOB_TOO_LARGE) {
      return {
        path: input.filePath,
        original: '',
        modified: '',
        language: langFromPath(input.filePath),
        binary: false,
        tooLarge: true
      }
    }
    throw err
  }

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
}

export interface LocalDiffDeps {
  /** Find the local clone whose origin matches the PR's repository, or throw if none exists. */
  resolveRepoDir(repoName: string, workspaceFolders: string[]): Promise<string>
}

export interface LocalDiffService {
  getChanges(pr: PullRequest, workspaceFolders: string[]): Promise<PrChangeFile[]>
  getFileDiff(pr: PullRequest, filePath: string, workspaceFolders: string[]): Promise<FileDiff>
}

const prKey = (repositoryId: string, prId: number): string => `${repositoryId}:${prId}`

/** True when the commit exists in the repo's object database. */
async function hasCommit(repoDir: string, commit: string): Promise<boolean> {
  if (!commit) return false
  return git(repoDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).then(
    () => true,
    () => false
  )
}

/**
 * Local-git diff service. Resolves each PR to its local clone once (cached), fetches the PR's
 * commits when they are not yet present, then answers changes and per-file diffs from git objects -
 * no Azure DevOps content calls. Requires a local clone; propagates resolveRepoDir's error when none
 * exists so the caller can prompt the user to add the clone as a workspace.
 */
export function createLocalDiffService(d: LocalDiffDeps): LocalDiffService {
  const repoDirByPr = new Map<string, string>()

  /** Resolve (and cache) the clone, then ensure both PR commits are present locally. */
  async function prepare(pr: PullRequest, workspaceFolders: string[]): Promise<string> {
    const key = prKey(pr.repositoryId, pr.prId)
    let repoDir = repoDirByPr.get(key)
    if (!repoDir) {
      repoDir = await d.resolveRepoDir(pr.repositoryName, workspaceFolders)
      repoDirByPr.set(key, repoDir)
    }

    if (!(await hasCommit(repoDir, pr.sourceCommitId))) {
      await gitWithLockRetry(repoDir, ['fetch', '--no-tags', 'origin', pr.sourceRefName], 180_000).catch(
        () =>
          gitWithLockRetry(
            repoDir!,
            ['fetch', '--no-tags', 'origin', `refs/pull/${pr.prId}/merge`],
            180_000
          ).catch(() => {})
      )
    }
    if (!(await hasCommit(repoDir, pr.targetCommitId))) {
      await gitWithLockRetry(repoDir, ['fetch', '--no-tags', 'origin', pr.targetRefName], 180_000).catch(
        () => {}
      )
    }
    return repoDir
  }

  return {
    async getChanges(pr, workspaceFolders) {
      const repoDir = await prepare(pr, workspaceFolders)
      return localChanges(repoDir, pr.targetCommitId, pr.sourceCommitId)
    },

    async getFileDiff(pr, filePath, workspaceFolders) {
      const repoDir = await prepare(pr, workspaceFolders)
      const changes = await localChanges(repoDir, pr.targetCommitId, pr.sourceCommitId)
      const change = changes.find((c) => c.path === filePath)
      return localFileDiff(repoDir, {
        targetCommit: pr.targetCommitId,
        sourceCommit: pr.sourceCommitId,
        filePath,
        originalPath: change?.originalPath ?? null,
        changeType: change?.changeType ?? 'edit'
      })
    }
  }
}
