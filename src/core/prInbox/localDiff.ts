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
 * Walk a NUL-separated git stream field by field. The trailing NUL leaves an empty last field,
 * which is not a record and is dropped.
 */
function nulFields(raw: string): string[] {
  const fields = raw.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  return fields
}

/** A changed file as the file-list run describes it: what happened, and to which path. */
export type NamedChange = Omit<PrChangeFile, 'added' | 'removed'>

/**
 * Parse the NUL-separated `--name-status -M -z` stream into change records. Paths are normalized to
 * the Azure DevOps convention used everywhere else in the PR pipeline (leading slash), so thread
 * matching, comment badges, and draft publishing all key off the same shape. This run says what
 * happened to each file and nothing about how much of it changed, so the line counts are left to
 * the caller rather than filled in with a zero that would be indistinguishable from a file that
 * genuinely gained and lost nothing.
 */
export function parseNameStatus(raw: string): NamedChange[] {
  const changes: NamedChange[] = []
  const fields = nulFields(raw)
  let i = 0
  while (i < fields.length) {
    const status = fields[i++]
    if (!status) continue
    // A rename or a copy names both sides, each as a field of its own; everything else names one.
    const twoSided = status[0] === 'R' || status[0] === 'C'
    const first = fields[i++]
    const second = twoSided ? fields[i++] : undefined
    const path = twoSided ? second : first
    if (!path) continue
    changes.push({
      path: `/${path}`,
      changeType: changeTypeOf(status),
      originalPath: twoSided ? `/${first}` : null
    })
  }
  return changes
}

/**
 * Line counts from the `--numstat -M -z` stream, keyed by the same leading-slash path
 * {@link parseNameStatus} produces. A binary file, which git reports as `-` on both sides, counts
 * as no lines rather than as a number nothing can be added to.
 */
export function parseNumstat(raw: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>()
  const fields = nulFields(raw)
  let i = 0
  while (i < fields.length) {
    const head = fields[i++]
    const firstTab = head.indexOf('\t')
    const secondTab = head.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    // A rename leaves the path slot of the head empty and follows it with the old and then the new
    // path, each as a field of its own. The new side is what the rest of the pipeline keys off.
    let path = head.slice(secondTab + 1)
    if (!path) {
      i++
      path = fields[i++] ?? ''
    }
    if (!path) continue
    counts.set(`/${path}`, {
      added: lineCount(head.slice(0, firstTab)),
      removed: lineCount(head.slice(firstTab + 1, secondTab))
    })
  }
  return counts
}

/** One side of a numstat record. Git writes `-` for a binary file, which counts as no lines. */
function lineCount(field: string): number {
  return Number.parseInt(field, 10) || 0
}

/**
 * Give each changed file the lines it gained and lost. Both git runs behind these two arguments see
 * the same revisions with the same rename detection, so they always name the same files; a file
 * with no counts to its name therefore means one of them was read wrong, and throwing says so.
 * Reporting it as 0 / 0 instead would be a size the reviewer has no way to tell from a real one.
 */
export function withCounts(
  named: NamedChange[],
  counts: Map<string, { added: number; removed: number }>
): PrChangeFile[] {
  return named.map((change) => {
    const counted = counts.get(change.path)
    if (!counted) {
      throw new Error(`git listed ${change.path} as changed but reported no line counts for it.`)
    }
    return { ...change, ...counted }
  })
}

/**
 * The PR's changed files with their line counts, computed locally against the merge base of target
 * and source (three-dot), so target-side changes not part of the PR are excluded - matching the
 * Azure DevOps web diff. Git answers the file list and the line counts on separate runs, joined
 * here by path.
 */
export async function localChanges(
  repoDir: string,
  targetCommit: string,
  sourceCommit: string
): Promise<PrChangeFile[]> {
  // `-z` on both runs: it spells every path plainly and in full - no `a/{b => c}/f.ts` shorthand to
  // expand, and no C-quoting of paths that hold a quote, a backslash or a tab. The path git prints
  // is the path, which is what lets the two runs be joined on it and lets a failed join mean a bug
  // rather than a shape nobody thought of.
  const diffArgs = (mode: string): string[] => [
    'diff',
    '--merge-base',
    mode,
    '-M',
    '-z',
    targetCommit,
    sourceCommit
  ]
  const [nameStatus, numstat] = await Promise.all([
    gitRaw(repoDir, diffArgs('--name-status')),
    gitRaw(repoDir, diffArgs('--numstat'))
  ])
  return withCounts(parseNameStatus(nameStatus), parseNumstat(numstat))
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
