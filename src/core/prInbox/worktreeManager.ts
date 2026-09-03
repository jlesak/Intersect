import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git, gitWithLockRetry } from './git'
import { remoteMatchesRepoName } from './worktreeMatch'

/** All managed worktrees live under one app-owned root so a startup sweep is unambiguous. */
export function worktreesRoot(userDataDir: string): string {
  return join(userDataDir, 'pr-review-worktrees')
}

export interface CreateWorktreeInput {
  repoDir: string
  dirName: string
  sourceCommit: string
  sourceRefName: string
  prId: number
}

export interface WorktreeManager {
  resolveRepoDir(repoName: string, workspaceFolders: string[]): Promise<string>
  createWorktree(input: CreateWorktreeInput): Promise<string>
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>
  pruneStale(repoDirs: string[]): Promise<void>
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

export function createWorktreeManager(userDataDir: string): WorktreeManager {
  const root = (): string => worktreesRoot(userDataDir)
  const onClone = createCloneQueue()

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
