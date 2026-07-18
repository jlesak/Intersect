import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Project, RepoWorktrees, WorktreeInfo } from '@common/domain'

const exec = promisify(execFile)

/**
 * Parse `git worktree list --porcelain` output into worktree entries. Each stanza starts with a
 * `worktree <path>` line followed by attribute lines (`HEAD`, `branch`, `detached`, ...) and a
 * blank separator. Unknown attributes are ignored so newer git versions stay parseable.
 */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = []
  let current: { path: string; head: string; branch: string | null } | null = null

  const flush = (): void => {
    if (current) worktrees.push({ path: current.path, head: current.head, branch: current.branch })
    current = null
  }

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length), head: '', branch: null }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  flush()
  return worktrees
}

/**
 * List the git worktrees under each repository binding of a project. A binding whose folder is
 * missing or not a git repository reports its error inline instead of failing the whole listing,
 * so one broken binding never hides the healthy ones.
 */
export async function listProjectWorktrees(project: Project): Promise<RepoWorktrees[]> {
  return Promise.all(
    project.repoPaths.map(async (repoPath): Promise<RepoWorktrees> => {
      try {
        const { stdout } = await exec(
          'git',
          ['-C', repoPath, 'worktree', 'list', '--porcelain'],
          { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
        )
        return { repoPath, worktrees: parseWorktreeList(stdout), error: null }
      } catch (err) {
        return {
          repoPath,
          worktrees: [],
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
  )
}
