import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectGitAction, ProjectGitBranch, ProjectGitPreview, ProjectGitStatus } from '@common/domain'
import { Dialog } from '@renderer/shared/ui/Dialog'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import * as api from '../ipc'

function label(status: ProjectGitStatus): string {
  if (status.error) return 'not a git repository'
  const branch = status.branch ?? `detached @ ${status.head.slice(0, 8)}`
  return [
    branch,
    status.ahead ? `↑${status.ahead}` : '',
    status.behind ? `↓${status.behind}` : '',
    status.files.length ? `●${status.files.length}` : '',
    status.branch && !status.upstream ? 'no upstream' : '',
    status.progress ? `${status.progress} in progress` : ''
  ].filter(Boolean).join(' ')
}

function hint(status: ProjectGitStatus): string {
  return status.error ?? `${status.mainPath}\n${status.branch ?? 'detached HEAD'} → ${status.upstream ?? 'no upstream'}\n${status.ahead} ahead · ${status.behind} behind · ${status.files.length} changed`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const folderName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

export function ProjectGitChips({ projectId, repoPaths }: { projectId: string; repoPaths: string[] }) {
  const [statuses, setStatuses] = useState<ProjectGitStatus[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [branches, setBranches] = useState<ProjectGitBranch[]>([])
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [busyByPath, setBusyByPath] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<'commit' | 'branch' | null>(null)
  const [preview, setPreview] = useState<ProjectGitPreview | null>(null)
  const [message, setMessage] = useState('')
  const [output, setOutput] = useState('')
  const [name, setName] = useState('')
  const [start, setStart] = useState('HEAD')
  const [nameError, setNameError] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState({ left: 0, top: 0 })
  const [focused, setFocused] = useState(true)
  const filterRef = useRef<HTMLInputElement>(null)
  const previewPath = useRef<string | null>(null)
  const generation = useRef(0)
  const polling = useRef(false)
  const alive = useRef(true)
  const status = statuses.find((s) => s.repoPath === open)
  const busy = !!(open && busyByPath[open])
  const dialogBusy = !!busyByPath[previewPath.current ?? '']
  const begin = (path: string, verb: string): void =>
    setBusyByPath((current) => ({ ...current, [path]: verb }))
  const end = (path: string): void => setBusyByPath((current) => {
    const next = { ...current }
    delete next[path]
    return next
  })

  const refresh = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    const current = generation.current
    try {
      const next = await api.gitStatuses(projectId)
      if (alive.current && current === generation.current) setStatuses(next)
    } catch (error) {
      if (alive.current && current === generation.current) reportError('Could not read project Git state', error)
    } finally {
      polling.current = false
    }
  }, [projectId])

  useEffect(() => {
    alive.current = true
    generation.current++
    setStatuses([])
    void refresh()
    const onFocus = () => { setFocused(true); void refresh() }
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      alive.current = false
      generation.current++
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [refresh])

  useEffect(() => {
    if (!focused) return
    const timer = window.setInterval(() => { void refresh() }, 1500)
    return () => window.clearInterval(timer)
  }, [focused, refresh])

  useEffect(() => {
    if (!open) return
    let valid = true
    setBranches([])
    void api.gitBranches(projectId, open).then((value) => { if (valid) setBranches(value) })
      .catch((error) => { if (valid) reportError('Could not list branches', error) })
    return () => { valid = false }
  }, [open, projectId, busy])

  useEffect(() => { if (open) filterRef.current?.focus() }, [open, branches.length])

  useEffect(() => {
    const path = previewPath.current
    if (dialog !== 'branch' || !path) return
    let valid = true
    void api.gitValidateName(projectId, path, name).then((result) => { if (valid) setNameError(result) })
      .catch((error) => { if (valid) setNameError(errorText(error)) })
    return () => { valid = false }
  }, [dialog, name, projectId])

  function showMenu(path: string, button: HTMLButtonElement): void {
    if (open === path) { setOpen(null); return }
    const box = button.getBoundingClientRect()
    setMenuAt({ left: Math.min(box.left, window.innerWidth - 430), top: Math.min(box.bottom + 4, window.innerHeight - 500) })
    setOpen(path)
    setFilter('')
    setActive(0)
  }

  async function execute(action: ProjectGitAction): Promise<void> {
    if (!open || busy) return
    const path = open
    begin(path, ({ pull: 'Pulling…', push: 'Pushing…', fetch: 'Fetching…', switch: 'Switching…', 'new-branch': 'Creating branch…' } as const)[action.kind])
    try {
      useToastStore.getState().push(await api.gitAction(projectId, path, action))
      setOpen(null)
    } catch (error) {
      reportError('Git operation failed', error)
    } finally {
      end(path)
      void refresh()
    }
  }

  async function openCommit(): Promise<void> {
    if (!open) return
    try {
      setPreview(await api.gitPreview(projectId, open))
      setMessage('')
      setOutput('')
      setDialog('commit')
      setOpen(null)
    } catch (error) { reportError('Could not preview commit', error) }
  }

  async function submitCommit(push: boolean): Promise<void> {
    const path = previewPath.current
    if (!path || !preview || !message.trim() || dialogBusy) return
    begin(path, 'Committing…')
    setOutput('')
    try {
      const result = await api.gitCommit(projectId, path, preview.token, message, push)
      if (result.outcome === 'preview-changed') {
        setPreview(result.preview)
        setOutput('Changes have changed since the preview. Review the new list and confirm again.')
      } else if (result.outcome === 'failed') {
        setPreview(result.preview)
        setOutput(result.error)
        reportError('Commit failed', result.error)
      } else {
        setDialog(null)
        setPreview(null)
        if (result.outcome === 'committed-push-failed') reportError('Push failed', result.error)
        else useToastStore.getState().push(`Committed ${result.commit}`)
      }
    } catch (error) { setOutput(errorText(error)); reportError('Commit failed', error) }
    finally { end(path); void refresh() }
  }

  function openBranch(initial = ''): void {
    previewPath.current = open
    if (open) {
      void api.gitBranches(projectId, open).then(setBranches)
        .catch((error) => reportError('Could not list branches', error))
    }
    setName(initial)
    setStart('HEAD')
    setNameError(initial ? null : 'Branch name is required')
    setDialog('branch')
    setOpen(null)
  }

  async function createBranch(): Promise<void> {
    const path = previewPath.current
    if (!path || dialogBusy || nameError || !name) return
    begin(path, 'Creating branch…')
    try {
      useToastStore.getState().push(await api.gitAction(projectId, path, { kind: 'new-branch', name, start }))
      setDialog(null)
    } catch (error) { reportError('Could not create branch', error) }
    finally { end(path); void refresh() }
  }

  const filtered = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  const noMatch = filter.trim() && !filtered.length
  const choices = filtered.filter((b) => !b.current && !b.inWorktree)
  const select = (branch: ProjectGitBranch) => { void execute({ kind: 'switch', branch: branch.name, remote: branch.kind === 'remote' }) }
  const inProgress = !!status?.progress
  const disabled = !!busy || inProgress || !!status?.error
  const canPush = !!status?.branch && (!status.upstream || status.ahead > 0)
  const at = Math.max(0, Math.min(active, choices.length - 1))

  return <>
    <div className="ix-git__chips">
      {repoPaths.map((path) => {
        const item = statuses.find((s) => s.repoPath === path)
        return <button key={path} type="button"
          className={`ix-git__chip${item?.error ? ' ix-git__chip--error' : ''}`}
          title={item ? hint(item) : path}
          onClick={(e) => showMenu(path, e.currentTarget)}
          aria-label={`Git ${folderName(path)}: ${item ? label(item) : 'Loading'}`}
        >
          {repoPaths.length > 1 && <span className="ix-git__folder">{folderName(path)}</span>}
          {busyByPath[path] && <span className="ix-git__spinner" aria-hidden="true">◌</span>}
          <span className="ix-git__branch">⎇ {busyByPath[path] ?? (item ? label(item) : 'Loading…')}</span>
          <span aria-hidden="true">▾</span>
        </button>
      })}
    </div>
    {open && status && createPortal(<>
      <div className="ix-git__backdrop" onMouseDown={() => setOpen(null)} />
      <div className="ix-git__menu" role="menu" style={{
        left: Math.max(6, menuAt.left),
        top: Math.max(6, menuAt.top),
        maxHeight: Math.max(100, window.innerHeight - Math.max(6, menuAt.top) - 6)
      }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setOpen(null) }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((n) => (n + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % Math.max(choices.length, 1))
          }
          if (e.key === 'Enter' && document.activeElement === filterRef.current) {
            e.preventDefault()
            if (noMatch) openBranch(filter.trim())
            else if (choices[at]) select(choices[at])
          }
        }}
      >
        <div className="ix-git__summary">{status.mainPath ?? status.repoPath} · main checkout<br />
          {status.branch ?? 'detached HEAD'} → {status.upstream ?? 'no upstream'} · {status.behind} behind · {status.files.length} changed
          {inProgress && <div>Finish {status.progress} in a terminal.</div>}
        </div>
        <div className="ix-git__actions">
          <button disabled={disabled || !status.branch || !status.upstream} onClick={() => void execute({ kind: 'pull' })}>Pull <small>{status.behind ? `${status.behind} commits` : 'up to date'}</small></button>
          <button disabled={disabled || !canPush} onClick={() => void execute({ kind: 'push' })}>Push <small>{!status.upstream ? 'sets upstream' : status.ahead ? `${status.ahead} commits` : 'nothing to push'}</small></button>
          <button disabled={disabled || !status.branch || !status.files.length} onClick={() => { previewPath.current = open; void openCommit() }}>Commit… <small>{status.files.length} files</small></button>
          <button disabled={disabled} onClick={() => openBranch()}>New branch…</button>
          <button disabled={!!busy || !!status.error} onClick={() => void execute({ kind: 'fetch' })}>Fetch <small>updates ↑↓ counts</small></button>
        </div>
        <input ref={filterRef} placeholder="Switch branch: type to filter" value={filter}
          onChange={(e) => { setFilter(e.target.value); setActive(0) }} aria-label="Switch branch" />
        <div className="ix-git__branch-list">
          {filtered.some((b) => b.kind === 'local') && <div className="ix-git__section">LOCAL</div>}
          {filtered.filter((b) => b.kind === 'local').map((b) =>
            <button key={b.name} disabled={disabled || b.current || b.inWorktree} className={choices[at] === b ? 'ix-git__active' : ''}
              onClick={() => select(b)}>{b.current ? '✓ ' : ''}{b.name}<small>{b.current ? 'current' : b.inWorktree ? 'in worktree' : ''}</small></button>)}
          {filtered.some((b) => b.kind === 'remote') && <div className="ix-git__section">REMOTE ONLY</div>}
          {filtered.filter((b) => b.kind === 'remote').map((b) =>
            <button key={b.name} disabled={disabled} className={choices[at] === b ? 'ix-git__active' : ''}
              onClick={() => select(b)}>{b.name}</button>)}
          {noMatch && <button disabled={disabled} onClick={() => openBranch(filter.trim())}>Create branch "{filter.trim()}"</button>}
        </div>
        {!!(status.claudeSessions || status.terminalSessions) && <div className="ix-git__warning">
          {status.claudeSessions} Claude session{status.claudeSessions === 1 ? '' : 's'} and {status.terminalSessions} terminal{status.terminalSessions === 1 ? '' : 's'} run in this folder. Switching changes their files.
        </div>}
      </div>
    </>, document.body)}
    {dialog === 'commit' && preview && <Dialog title={`Commit to ${statuses.find((s) => s.repoPath === previewPath.current)?.branch ?? ''}`}
      onClose={() => { if (!dialogBusy) setDialog(null) }}
      actions={<><button className="ix-btn" onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</button>
        <button className="ix-btn" disabled={dialogBusy || !message.trim()} onClick={() => void submitCommit(false)}>Commit</button>
        <button className="ix-btn ix-btn--primary" disabled={dialogBusy || !message.trim()} onClick={() => void submitCommit(true)}>Commit and push</button></>}>
      <p>{preview.mode === 'all' ? 'All changes go into the commit, new files too.' :
        `Only the ${preview.files.length} staged files go in. ${preview.otherCount} other changes stay uncommitted.`}</p>
      <ul className="ix-git__preview">{preview.files.map((file) => <li key={file.path}>{file.code} {file.path}</li>)}</ul>
      <label className="ix-git__field">Message<textarea autoFocus value={message} onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => { if (e.metaKey && e.key === 'Enter') { e.preventDefault(); void submitCommit(false) } }} /></label>
      {output && <pre className="ix-git__output">{output}</pre>}
    </Dialog>}
    {dialog === 'branch' && <Dialog title="New branch" onClose={() => { if (!dialogBusy) setDialog(null) }}
      actions={<><button className="ix-btn" onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</button>
        <button className="ix-btn ix-btn--primary" disabled={dialogBusy || !!nameError || !name} onClick={() => void createBranch()}>Create and switch</button></>}>
      <label className="ix-git__field">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {nameError && <p className="ix-ctx__error">{nameError}</p>}
      <label className="ix-git__field">Start from<select value={start} onChange={(e) => setStart(e.target.value)}>
        <option value="HEAD">Current HEAD</option>
        {branches.filter((b) => b.defaultRemote).slice(0, 1).map((b) => <option key={b.name} value={b.kind === 'remote' ? b.name : `origin/${b.name}`}>origin/{b.kind === 'remote' ? b.name.slice(7) : b.name}</option>)}
        {branches.filter((b) => b.kind === 'local' && !b.current).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
      </select></label>
      <p>Your uncommitted changes come along.</p>
    </Dialog>}
  </>
}
