import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectPathDeps } from './resolveProject'

/**
 * The canonical absolute form of a path: symlinks resolved when the path exists. A missing
 * path (a binding may point at a folder that is not cloned yet) canonicalizes its deepest
 * existing ancestor and keeps the missing tail verbatim, so it still compares and matches
 * consistently with existing siblings under symlinked ancestors.
 */
export function canonicalizePath(path: string): string {
  const absolute = resolve(path)
  let dir = absolute
  const missingTail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(dir)
      return missingTail.length === 0 ? real : join(real, ...missingTail)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return absolute
      missingTail.unshift(basename(dir))
      dir = parent
    }
  }
}

/** The `gitdir: <path>` line a linked worktree's `.git` file carries. */
const GITDIR_LINE = /^gitdir:\s*(.+)\s*$/m

/** The `<parent>/.git/worktrees/<name>` shape that distinguishes worktrees from submodules. */
const WORKTREE_GITDIR = `${sep}.git${sep}worktrees${sep}`

/**
 * When the path lies inside a linked git worktree, the canonical root of the repository the
 * worktree belongs to; null for ordinary folders, main checkouts, submodules, and missing
 * paths. Reads the worktree's `.git` pointer file directly instead of running git, so the
 * answer is instant and works without git on PATH.
 */
export function worktreeParentRoot(path: string): string | null {
  let dir = canonicalizePath(path)
  for (;;) {
    const gitPath = resolve(dir, '.git')
    let kind: 'file' | 'dir' | 'absent'
    try {
      kind = statSync(gitPath).isDirectory() ? 'dir' : 'file'
    } catch {
      kind = 'absent'
    }

    if (kind === 'dir') return null // an ordinary repository root
    if (kind === 'file') {
      let content: string
      try {
        content = readFileSync(gitPath, 'utf8')
      } catch {
        return null
      }
      const match = GITDIR_LINE.exec(content)
      if (!match) return null
      const gitdir = isAbsolute(match[1]) ? match[1] : resolve(dir, match[1])
      const marker = gitdir.lastIndexOf(WORKTREE_GITDIR)
      if (marker === -1) return null // a submodule or something else pointer-shaped
      return canonicalizePath(gitdir.slice(0, marker))
    }

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The production wiring of the resolver's impure edges. */
export const projectPathDeps: ProjectPathDeps = {
  canonicalize: canonicalizePath,
  worktreeParentRoot
}
