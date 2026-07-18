import { useCallback, useEffect, useState } from 'react'
import type { RepoWorktrees } from '@common/domain'
import { IconBranch, IconRefresh } from '@renderer/shared/ui/icons'
import * as api from '../ipc'

/**
 * The Worktrees entry point of a project context: the live `git worktree` inventory of each
 * repository binding, read on open (no cache - worktrees change under our feet). A broken
 * binding shows its error inline so healthy repos stay visible.
 */
export function ProjectWorktrees({ projectId }: { projectId: string }) {
  const [repos, setRepos] = useState<RepoWorktrees[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setRepos(await api.listWorktrees(projectId))
    } catch (e) {
      setRepos([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useEffect(() => {
    setRepos(null)
    void load()
  }, [load])

  if (repos === null) {
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">Worktrees</span>
        <div className="ix-empty__title">Reading repositories…</div>
      </div>
    )
  }

  return (
    <div className="ix-ctx__panel">
      <div className="ix-ctx__toolbar">
        <button type="button" className="ix-btn" onClick={() => void load()}>
          <IconRefresh /> Refresh
        </button>
      </div>
      {error && <p className="ix-ctx__error">{error}</p>}
      {repos.map((repo) => (
        <div key={repo.repoPath} className="ix-ctx__group">
          <div className="ix-ctx__group-head" title={repo.repoPath}>
            {repo.repoPath}
          </div>
          {repo.error && <p className="ix-ctx__error">{repo.error}</p>}
          {!repo.error && repo.worktrees.length === 0 && (
            <p className="ix-ctx__hint">No worktrees.</p>
          )}
          {repo.worktrees.map((wt) => (
            <div key={wt.path} className="ix-ctx__row ix-ctx__row--static">
              <span className="ix-ctx__row-title">
                <IconBranch /> {wt.branch ?? `detached @ ${wt.head.slice(0, 8)}`}
              </span>
              <span className="ix-ctx__row-meta">{wt.path}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
