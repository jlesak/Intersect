import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { canonicalizePath } from '../projects/paths'
import { parseWorktreeList } from '../projects/worktrees'
import { git, gitWithLockRetry } from './git'
import { remoteMatchesRepoName } from './worktreeMatch'

/** All managed worktrees live under one app-owned root so a startup sweep is unambiguous. */
export function worktreesRoot(userDataDir: string): string {
  return join(userDataDir, 'pr-review-worktrees')
}

/**
 * Worktrees for fixing my own pull requests live under a root of their own. They can hold work
 * the user has not committed yet, so they must stay out of reach of the review root's boot sweep,
 * which force-deletes everything it finds.
 */
export function fixWorktreesRoot(userDataDir: string): string {
  return join(userDataDir, 'pr-fix-worktrees')
}

/** `<repo-slug>-pr<id>`: one folder per pull request, readable as a workspace name. */
export function fixWorktreeDirName(pr: { repositoryName: string; prId: number }): string {
  const slug = pr.repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 40)
  return `${slug}-pr${pr.prId}`
}

/** The canonical folder of a pull request's fix worktree. */
export function fixWorktreePath(
  userDataDir: string,
  pr: { repositoryName: string; prId: number }
): string {
  return canonicalizePath(join(fixWorktreesRoot(userDataDir), fixWorktreeDirName(pr)))
}

/**
 * Whether the path lies inside the fix root. Both sides are canonicalized, so a symlinked profile
 * folder, or macOS reporting `/private/var` for `/var`, cannot hide a fix worktree. A path that
 * no longer exists still counts: its deepest existing ancestor decides.
 */
export function isFixWorktreePath(userDataDir: string, path: string): boolean {
  const root = canonicalizePath(fixWorktreesRoot(userDataDir))
  return canonicalizePath(path).startsWith(`${root}${sep}`)
}

/** The branch a pull request's source ref names. Fixing needs a branch to commit on. */
export function sourceBranch(sourceRefName: string): string {
  const branch = sourceRefName.startsWith('refs/heads/')
    ? sourceRefName.slice('refs/heads/'.length)
    : ''
  if (!branch) throw new Error(`The pull request's source is not a branch: ${sourceRefName}`)
  return branch
}

/** What git said, without the "Command failed: git ..." line Node puts in front of it. */
function gitMessage(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return err instanceof Error ? err.message : String(err)
}

export interface CreateWorktreeInput {
  repoDir: string
  dirName: string
  sourceCommit: string
  sourceRefName: string
  prId: number
}

export interface CreateBranchWorktreeInput {
  /** The clone, as `resolveRepoDir` found it; also the clone-queue key reviews use. */
  repoDir: string
  /** The canonical fix worktree folder. */
  path: string
  branch: string
}

export interface RemoveCleanResult {
  outcome: 'removed' | 'dirty' | 'failed'
  detail: string | null
}

export interface WorktreeManager {
  resolveRepoDir(repoName: string, workspaceFolders: string[]): Promise<string>
  createWorktree(input: CreateWorktreeInput): Promise<string>
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>
  pruneStale(repoDirs: string[]): Promise<void>
  /**
   * Fetch the branch and check it out in a worktree at `path`, reusing one already there.
   * `diverged` is true when the local branch and origin's both have commits the other lacks; the
   * worktree then stays on the local branch, untouched.
   */
  createBranchWorktree(input: CreateBranchWorktreeInput): Promise<{ diverged: boolean }>
  /**
   * Remove a fix worktree only when it holds nothing uncommitted or untracked, never by force.
   * Not queued behind the clone's fetches: it touches only the worktree's own folder and its
   * entry under `.git/worktrees`, so it cannot contend with their ref locks.
   */
  removeCleanWorktree(path: string): Promise<RemoveCleanResult>
}

export interface WorktreeManagerOptions {
  /** Test seam: the per-clone queue, so a test can hold it and prove what bypasses it. */
  onClone?: ReturnType<typeof createCloneQueue>
}

/**
 * Serializes work per clone. Two reviews starting at once on the same clone would run `git fetch`
 * and `git worktree add` concurrently in one repository, which fails on its index and ref locks.
 * `gitWithLockRetry` cannot cover that: it waits about 2.5 s in total while a real fetch holds its
 * locks for far longer, and its retry test does not recognise the "cannot lock ref" message a
 * concurrent fetch produces. Retrying is for contention with the user's own git; contention we
 * create ourselves is avoided instead.
 */
export function createCloneQueue(): <T>(repoDir: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(repoDir: string, work: () => Promise<T>): Promise<T> => {
    const tail = tails.get(repoDir) ?? Promise.resolve()
    // Run next whether the previous job resolved or rejected: one failed review must not stall
    // every later one on that clone.
    const next = tail.then(work, work)
    const settled = next.then(
      () => {},
      () => {}
    )
    tails.set(repoDir, settled)
    void settled.then(() => {
      if (tails.get(repoDir) === settled) tails.delete(repoDir)
    })
    return next
  }
}

export function createWorktreeManager(
  userDataDir: string,
  options: WorktreeManagerOptions = {}
): WorktreeManager {
  const root = (): string => worktreesRoot(userDataDir)
  const onClone = options.onClone ?? createCloneQueue()

  const addWorktree = async ({
    repoDir,
    dirName,
    sourceCommit,
    sourceRefName,
    prId
  }: CreateWorktreeInput): Promise<string> => {
    const path = join(root(), dirName)
    await mkdir(root(), { recursive: true })

    // Prefer the concrete source commit; on-prem Server doesn't reliably expose refs/pull/*/merge.
    let ref = sourceCommit
    const present =
      !!sourceCommit &&
      (await git(repoDir, ['rev-parse', '--verify', '--quiet', `${sourceCommit}^{commit}`]).then(
        () => true,
        () => false
      ))
    if (!present) {
      try {
        await gitWithLockRetry(repoDir, ['fetch', '--no-tags', 'origin', sourceRefName], 180_000)
      } catch {
        await gitWithLockRetry(
          repoDir,
          ['fetch', '--no-tags', 'origin', `refs/pull/${prId}/merge`],
          180_000
        ).catch(() => {
          throw new Error(`Could not fetch PR ${prId} source (${sourceRefName}) from origin.`)
        })
      }
      ref = sourceCommit || 'FETCH_HEAD'
    }

    // Detached, so two pull requests from one clone never fight over a checked-out branch.
    await gitWithLockRetry(repoDir, ['worktree', 'add', '--detach', path, ref])
    return path
  }

  const dropWorktree = async (repoDir: string, worktreePath: string): Promise<void> => {
    try {
      await git(repoDir, ['worktree', 'remove', '--force', worktreePath])
    } catch {
      if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true })
    } finally {
      await git(repoDir, ['worktree', 'prune']).catch(() => {})
    }
  }

  const addBranchWorktree = async ({
    repoDir,
    path,
    branch
  }: CreateBranchWorktreeInput): Promise<{ diverged: boolean }> => {
    const tracking = `refs/remotes/origin/${branch}`
    try {
      await gitWithLockRetry(
        repoDir,
        ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${tracking}`],
        180_000
      )
    } catch (err) {
      throw new Error(`Could not fetch ${branch} from origin: ${gitMessage(err)}`)
    }

    // A worktree whose folder was deleted by hand stays registered, holding its branch, until it
    // is pruned. Pruning first means such a folder is checked out afresh instead of "reused".
    await git(repoDir, ['worktree', 'prune']).catch(() => {})

    // A branch can be checked out in one worktree only. Elsewhere (often the main clone) means the
    // user has to free it; here means an earlier start made this worktree and it is reused.
    const target = canonicalizePath(path)
    const listed = parseWorktreeList(await git(repoDir, ['worktree', 'list', '--porcelain']))
    let reuse = false
    for (const wt of listed) {
      if (wt.branch !== branch) continue
      const at = canonicalizePath(wt.path)
      if (at !== target) {
        throw new Error(
          `Branch ${branch} is checked out in ${at}. Switch that checkout to another branch, then try again.`
        )
      }
      reuse = true
    }

    if (!reuse) {
      if (existsSync(path)) {
        throw new Error(
          `${path} is left over from an incomplete removal. Delete that folder, then try again.`
        )
      }
      await mkdir(fixWorktreesRoot(userDataDir), { recursive: true })
      const localExists = await git(repoDir, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`
      ]).then(
        () => true,
        () => false
      )
      if (!localExists) {
        // A fresh local branch made from origin's, tracking it. Never -B, which would reset a
        // branch that already exists, and never --detach, which would leave nothing to commit on.
        await gitWithLockRetry(repoDir, [
          'worktree',
          'add',
          '--track',
          '-b',
          branch,
          path,
          tracking
        ])
        return { diverged: false }
      }
      await gitWithLockRetry(repoDir, ['worktree', 'add', path, branch])
    }

    // An existing local branch catches up with origin when it only lags behind. When both sides
    // moved, the merge refuses and the worktree stays on the local commits for the user to decide.
    try {
      await git(path, ['merge', '--ff-only', '--quiet', tracking])
      return { diverged: false }
    } catch {
      return { diverged: true }
    }
  }

  const removeClean = async (path: string): Promise<RemoveCleanResult> => {
    let common: string
    try {
      const top = await git(path, ['rev-parse', '--show-toplevel'])
      if (canonicalizePath(top) !== canonicalizePath(path)) {
        return { outcome: 'failed', detail: `${path} is not the top of a git worktree` }
      }
      common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    } catch (err) {
      return { outcome: 'failed', detail: gitMessage(err) }
    }

    try {
      const status = await git(path, ['status', '--porcelain'])
      if (status) return { outcome: 'dirty', detail: status }
    } catch (err) {
      return { outcome: 'failed', detail: gitMessage(err) }
    }

    // Addressed through the repository, not from inside the folder being removed. No --force, and
    // no rm fallback: whatever git refuses to delete stays for the user to look at.
    const viaRepo = (args: string[]): Promise<string> =>
      gitWithLockRetry(common, [`--git-dir=${common}`, ...args])
    try {
      await viaRepo(['worktree', 'remove', path])
      return { outcome: 'removed', detail: null }
    } catch (err) {
      await viaRepo(['worktree', 'prune']).catch(() => {})
      return { outcome: 'failed', detail: gitMessage(err) }
    }
  }

  return {
    async resolveRepoDir(repoName, workspaceFolders) {
      for (const folder of workspaceFolders) {
        try {
          const origin = await git(folder, ['remote', 'get-url', 'origin'], 10_000)
          if (remoteMatchesRepoName(origin, repoName)) return folder
        } catch {
          // Not a git repo, or no origin - skip.
        }
      }
      throw new Error(
        `No local clone found for repository "${repoName}". Add a workspace whose folder is a clone of it.`
      )
    },

    createWorktree(input) {
      return onClone(input.repoDir, () => addWorktree(input))
    },

    removeWorktree(repoDir, worktreePath) {
      return onClone(repoDir, () => dropWorktree(repoDir, worktreePath))
    },

    createBranchWorktree(input) {
      return onClone(input.repoDir, () => addBranchWorktree(input))
    },

    removeCleanWorktree(path) {
      return removeClean(path)
    },

    /**
     * The boot sweep. It deletes every directory under the managed root, so it must only ever run
     * before any review of this session exists - the review manager holds start() until it is done.
     */
    async pruneStale(repoDirs) {
      const rootDir = root()
      for (const repoDir of repoDirs) {
        const listed = await git(repoDir, ['worktree', 'list', '--porcelain']).catch(() => '')
        for (const line of listed.split('\n')) {
          if (line.startsWith('worktree ')) {
            const p = line.slice('worktree '.length).trim()
            if (p.startsWith(rootDir)) {
              await git(repoDir, ['worktree', 'remove', '--force', p]).catch(() => {})
            }
          }
        }
        await git(repoDir, ['worktree', 'prune']).catch(() => {})
      }
      // Belt and suspenders: nuke any orphan directories left under the managed root.
      if (existsSync(rootDir)) {
        for (const name of await readdir(rootDir)) {
          await rm(join(rootDir, name), { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  }
}
