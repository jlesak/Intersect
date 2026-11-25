import { useCallback, useEffect, useState } from 'react'
import type { RepoWorktrees, WorktreeInfo, WorktreeSnapshot } from '@common/domain'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { Dialog } from '@renderer/shared/ui/Dialog'
import { IconBranch, IconRefresh, IconTrash } from '@renderer/shared/ui/icons'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import * as api from '../ipc'

type Selection = { repoPath: string; wt: WorktreeInfo }

export function deleteButtonLabel(tabs: number, danger: boolean): string {
  if (tabs && danger) return 'Close tabs, discard changes and delete'
  if (tabs) return 'Close tabs and delete'
  if (danger) return 'Discard changes and delete'
  return 'Delete'
}

function dateLabel(value: number | null): string {
  if (!value) return '–'
  const date = new Date(value)
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (day === midnight) return `today ${time}`
  if (day === yesterday) return `yesterday ${time}`
  const days = Math.round((midnight - day) / 86_400_000)
  return `${days} days ago`
}

function absoluteDate(value: number | null): string | undefined {
  if (value === null) return undefined
  const date = new Date(value)
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

function folderLabel(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

function tags(wt: WorktreeInfo): string[] {
  const out: string[] = []
  if (wt.main) out.push('main checkout')
  if (wt.changed.length) out.push(`${wt.changed.length} changed`)
  if (wt.unpushed) out.push(`${wt.unpushed} unpushed`)
  if (wt.goneOnOrigin) out.push('gone on origin')
  const tabs = wt.workspaces.reduce((n, ws) => n + ws.tabs, 0)
  if (tabs) out.push(`${tabs} tabs open`)
  if (wt.lockedReason !== null) out.push('locked')
  if (wt.prunableReason !== null) out.push('folder missing')
  if (wt.managed) out.push(wt.managed === 'review' ? 'PR review' : 'PR fix')
  return out.length ? out : ['clean']
}

function snapshot(wt: WorktreeInfo): WorktreeSnapshot {
  return {
    changed: wt.changed, lockedReason: wt.lockedReason,
    branch: wt.branch, head: wt.head, unpushed: wt.unpushed
  }
}

/** Always reads Git on entry and after every mutation or refusal. */
export function ProjectWorktrees({ projectId }: { projectId: string }) {
  const [repos, setRepos] = useState<RepoWorktrees[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)

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

  const open = (repoPath: string, wt: WorktreeInfo): void => {
    setDeleteBranch(Boolean(wt.branch) && wt.unpushed === 0)
    setSelected({ repoPath, wt })
  }

  const removeEntry = async (repoPath: string, path: string): Promise<void> => {
    setBusy(true)
    try {
      await api.removeWorktreeEntry(projectId, repoPath, path)
      useToastStore.getState().push('Removed the missing worktree entry.')
    } catch (e) {
      reportError('Could not remove the worktree entry', e)
    } finally {
      setBusy(false)
      await load()
    }
  }

  const confirm = async (): Promise<void> => {
    if (!selected || busy) return
    const { repoPath, wt } = selected
    setBusy(true)
    try {
      const result = await api.deleteWorktree({
        projectId, repoPath, path: wt.path, snapshot: snapshot(wt),
        discardChanges: wt.changed.length > 0,
        overrideLock: wt.lockedReason !== null,
        deleteBranch
      })
      if (result.outcome === 'deleted' || result.outcome === 'partial') {
        for (const id of result.workspaceIds) useWorkspacesStore.getState().forget(id)
      }
      if (result.outcome === 'deleted') {
        useToastStore.getState().push(
          `Deleted worktree ${wt.path.split('/').pop()}${result.branchDeleted ? ` and branch ${wt.branch}` : ''}. Closed ${result.closedTabs} tabs.`
        )
      } else if (result.outcome === 'partial') {
        useToastStore.getState().push(`Removed the worktree, but could not delete the branch: ${result.detail}`)
      } else {
        useToastStore.getState().push(result.detail)
      }
    } catch (e) {
      reportError('Could not delete the worktree', e)
    } finally {
      setSelected(null)
      setBusy(false)
      await load()
    }
  }

  if (repos === null) {
    return <div className="ix-empty">
      <span className="ix-eyebrow">Worktrees</span>
      <div className="ix-empty__title">Reading repositories…</div>
    </div>
  }

  const wt = selected?.wt
  const openTabs = wt?.workspaces.reduce((n, ws) => n + ws.tabs, 0) ?? 0
  const danger = Boolean(wt && (wt.changed.length || wt.lockedReason !== null))
  return (
    <div className="ix-ctx__panel ix-worktrees">
      <div className="ix-ctx__toolbar">
        <button type="button" className="ix-btn" onClick={() => void load()}>
          <IconRefresh /> Refresh
        </button>
      </div>
      {error && <p className="ix-ctx__error">{error}</p>}
      {repos.map((repo) => (
        <div key={repo.repoPath} className="ix-ctx__group">
          <div className="ix-ctx__group-head" title={repo.repoPath}>{repo.repoPath}</div>
          {repo.error && <p className="ix-ctx__error">{repo.error}</p>}
          {!repo.error && repo.worktrees.length === 0 && <p className="ix-ctx__hint">No worktrees.</p>}
          {!repo.error && repo.worktrees.length > 0 && (
            <table className="ix-worktrees__table">
              <thead><tr><th>Branch</th><th>Folder</th><th>Created</th><th>State</th><th aria-label="Action" /></tr></thead>
              <tbody>{repo.worktrees.map((item) => (
                <tr key={item.path}>
                  <td><span className="ix-worktrees__truncate" title={item.branch ?? `detached @ ${item.head.slice(0, 8)}`}>
                    <IconBranch /> {item.branch ?? `detached @ ${item.head.slice(0, 8)}`}
                  </span></td>
                  <td><span className="ix-worktrees__truncate" title={item.path}>{folderLabel(item.displayPath)}</span></td>
                  <td title={absoluteDate(item.createdAt)}>{dateLabel(item.createdAt)}</td>
                  <td><span className="ix-worktrees__states">{tags(item).map((tag) =>
                    <span key={tag} title={tag === 'locked' ? item.lockedReason ?? undefined : undefined}>{tag}</span>
                  )}</span></td>
                  <td className="ix-worktrees__action">
                    {!item.main && !item.managed && (item.prunableReason !== null
                      ? <button type="button" disabled={busy} onClick={() => void removeEntry(repo.repoPath, item.path)}>Remove entry</button>
                      : <button type="button" className="ix-worktrees__delete" aria-label={`Delete worktree ${item.branch ?? item.path}`}
                          onClick={() => open(repo.repoPath, item)}><IconTrash /></button>)}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ))}
      {wt && selected && <Dialog
        title={`Delete worktree ${wt.branch ?? `detached @ ${wt.head.slice(0, 8)}`}?`}
        onClose={() => !busy && setSelected(null)}
        overlayClass="ix-worktrees__overlay"
        actions={<>
          <button type="button" className="ix-btn" autoFocus disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
          <button type="button" className={danger ? 'ix-btn ix-btn--danger' : 'ix-btn ix-btn--primary'}
            disabled={busy} onClick={() => void confirm()}>{deleteButtonLabel(openTabs, danger)}</button>
        </>}
      >
        <p>Removes the folder {folderLabel(wt.displayPath)} and its git entry.
          {wt.createdAt !== null && ` Created ${absoluteDate(wt.createdAt)}.`}</p>
        {wt.workspaces.filter((ws) => ws.tabs > 0).map((ws) =>
          <p key={ws.id}>Workspace {ws.name} has {ws.tabs} tabs open here,
            {ws.runningClaude} with a running Claude session. Intersect closes them first.</p>
        )}
        {wt.changed.length > 0 && <div className="ix-worktrees__warning">
          <strong>{wt.changed.length} uncommitted changes will be lost:</strong>
          <ul>{wt.changed.slice(0, 20).map((file) =>
            <li key={file.path}><code>{file.code} {file.path}</code></li>
          )}</ul>
          {wt.changed.length > 20 && <p>and {wt.changed.length - 20} more</p>}
        </div>}
        {wt.lockedReason !== null && <p className="ix-worktrees__warning">
          This worktree is locked{wt.lockedReason ? `: ${wt.lockedReason}` : ''}. The lock will be overridden.
        </p>}
        {wt.branch && <label className="ix-worktrees__branch-option">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Also delete branch {wt.branch}
        </label>}
        {deleteBranch && wt.unpushed > 0 && <p className="ix-worktrees__warning">
          {wt.unpushed} commits are on no remote. Deleting the branch loses them.
        </p>}
      </Dialog>}
    </div>
  )
}
