import { sep } from 'node:path'
import type { Project } from '@common/domain'

/**
 * The impure edges the resolver needs, injected so the matching itself stays a pure, fully
 * testable function. Production wiring supplies `canonicalizePath` / `worktreeParentRoot`
 * from `./paths`.
 */
export interface ProjectPathDeps {
  /** Maps any path to its canonical absolute form (symlinks resolved when the path exists). */
  canonicalize(path: string): string
  /**
   * The canonical root of the parent repository when the path lies inside a linked git
   * worktree, or null for ordinary folders, main checkouts, and missing paths.
   */
  worktreeParentRoot(path: string): string | null
}

/**
 * Resolve which project a filesystem path (a session cwd, a worktree, a repo subfolder)
 * belongs to. The longest canonical repository-binding match wins; a path inside a linked git
 * worktree is recognized through its parent repository's binding. Archived projects never
 * receive new work. Returns the project id, or null for the virtual "Other" bucket - the
 * resolver never creates anything.
 *
 * Ties (equivalent bindings on more than one project, possible on migrated data) break
 * deterministically by manual project order, then id.
 */
export function resolveProjectForPath(
  path: string,
  projects: Project[],
  deps: ProjectPathDeps
): string | null {
  const active = projects.filter((p) => !p.archived)

  const bestFor = (target: string): { id: string; len: number; sortOrder: number } | null => {
    let best: { id: string; len: number; sortOrder: number } | null = null
    for (const project of active) {
      for (const binding of project.repoPaths) {
        const canonical = deps.canonicalize(binding)
        if (target !== canonical && !target.startsWith(canonical + sep)) continue
        const candidate = { id: project.id, len: canonical.length, sortOrder: project.sortOrder }
        if (
          best === null ||
          candidate.len > best.len ||
          (candidate.len === best.len &&
            (candidate.sortOrder < best.sortOrder ||
              (candidate.sortOrder === best.sortOrder && candidate.id < best.id)))
        ) {
          best = candidate
        }
      }
    }
    return best
  }

  const direct = bestFor(deps.canonicalize(path))
  if (direct) return direct.id

  const parentRoot = deps.worktreeParentRoot(path)
  if (parentRoot !== null) {
    const viaParent = bestFor(deps.canonicalize(parentRoot))
    if (viaParent) return viaParent.id
  }

  return null
}
