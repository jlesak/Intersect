import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { git, gitWithLockRetry } from './git'
import { remoteMatchesRepoName } from './worktreeMatch'

/** All managed worktrees live under one app-owned root so a startup sweep is unambiguous. */
export function worktreesRoot(): string {
  return join(app.getPath('userData'), 'pr-review-worktrees')
}

export interface WorktreeManager {
  resolveRepoDir(repoName: string, workspaceFolders: string[]): Promise<string>
  createWorktree(input: {
    repoDir: string
    dirName: string
    sourceCommit: string
    sourceRefName: string
    prId: number
  }): Promise<string>
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>
  pruneStale(repoDirs: string[]): Promise<void>
}

export function createWorktreeManager(): WorktreeManager {
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

    async createWorktree({ repoDir, dirName, sourceCommit, sourceRefName, prId }) {
      const path = join(worktreesRoot(), dirName)
      await mkdir(worktreesRoot(), { recursive: true })

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

      await gitWithLockRetry(repoDir, ['worktree', 'add', '--detach', path, ref])
      return path
    },

    async removeWorktree(repoDir, worktreePath) {
      try {
        await git(repoDir, ['worktree', 'remove', '--force', worktreePath])
      } catch {
        if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true })
      } finally {
        await git(repoDir, ['worktree', 'prune']).catch(() => {})
      }
    },

    async pruneStale(repoDirs) {
      const root = worktreesRoot()
      for (const repoDir of repoDirs) {
        const listed = await git(repoDir, ['worktree', 'list', '--porcelain']).catch(() => '')
        for (const line of listed.split('\n')) {
          if (line.startsWith('worktree ')) {
            const p = line.slice('worktree '.length).trim()
            if (p.startsWith(root)) {
              await git(repoDir, ['worktree', 'remove', '--force', p]).catch(() => {})
            }
          }
        }
        await git(repoDir, ['worktree', 'prune']).catch(() => {})
      }
      // Belt and suspenders: nuke any orphan directories left under the managed root.
      if (existsSync(root)) {
        for (const name of await readdir(root)) {
          await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  }
}
