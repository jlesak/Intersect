import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  GitChangedFile, GitProgress, Project, ProjectGitAction, ProjectGitBranch,
  ProjectGitCommitResult, ProjectGitPreview, ProjectGitStatus
} from '@common/domain'
import { parseWorktreeList } from './worktrees'

const exec = promisify(execFile)
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const NETWORK_TIMEOUT = 120_000

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** All calls use argv, never a shell; even a credential helper cannot ask on the terminal. */
export async function runGit(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    env, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024
  })
  return stdout
}

function canon(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

export async function commonGitDir(path: string): Promise<string> {
  return canon((await runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
}

export type RepoQueue = <T>(path: string, job: () => Promise<T>) => Promise<T>

/** The canonical common directory is shared by the main checkout and all linked worktrees. */
export function createRepoQueue(): RepoQueue {
  const tails = new Map<string, Promise<void>>()
  return async (path, job) => {
    const key = await commonGitDir(path)
    const tail = tails.get(key) ?? Promise.resolve()
    const next = tail.then(job, job)
    const settled = next.then(() => {}, () => {})
    tails.set(key, settled)
    void settled.then(() => { if (tails.get(key) === settled) tails.delete(key) })
    return next
  }
}

function pathAfterFields(record: string, fields: number): string {
  let at = 0
  for (let i = 0; i < fields; i++) at = record.indexOf(' ', at) + 1
  return record.slice(at)
}

/** Parse the NUL stream; the second path of a rename is consumed, never counted twice. */
export function parseGitStatus(raw: string): Pick<ProjectGitStatus,
  'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  let branch: string | null = null
  let head = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitChangedFile[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i]
    if (row.startsWith('# branch.oid ')) head = row.slice(13)
    else if (row.startsWith('# branch.head ')) {
      const value = row.slice(14)
      branch = value === '(detached)' ? null : value
    } else if (row.startsWith('# branch.upstream ')) upstream = row.slice(18)
    else if (row.startsWith('# branch.ab ')) {
      const match = row.match(/\+(\d+) -(\d+)/)
      if (match) { ahead = Number(match[1]); behind = Number(match[2]) }
    } else if (row.startsWith('1 ') || row.startsWith('2 ')) {
      const xy = row.slice(2, 4)
      const path = pathAfterFields(row, row[0] === '2' ? 9 : 8)
      if (row[0] === '2') i++ // original path
      files.push({
        path, staged: xy[0] !== '.', unstaged: xy[1] !== '.',
        code: xy[0] !== '.' ? xy[0] : xy[1]
      })
    } else if (row.startsWith('? ')) {
      files.push({ path: row.slice(2), staged: false, unstaged: true, code: '?' })
    } else if (row.startsWith('u ')) {
      files.push({ path: pathAfterFields(row, 10), staged: true, unstaged: true, code: 'U' })
    }
  }
  return { branch, head, upstream, ahead, behind, files }
}

async function progress(mainPath: string): Promise<GitProgress> {
  const dir = (await runGit(mainPath, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim()
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
  return null
}

async function resolveMain(repoPath: string): Promise<{ mainPath: string; commonDir: string }> {
  const commonDir = await commonGitDir(repoPath)
  const worktrees = parseWorktreeList(await runGit(repoPath, ['worktree', 'list', '--porcelain']))
  const first = worktrees[0]
  if (!first) throw new Error('Git returned no main checkout')
  return { mainPath: canon(first.path), commonDir }
}

async function readStatus(repoPath: string): Promise<ProjectGitStatus> {
  try {
    const { mainPath, commonDir } = await resolveMain(repoPath)
    const raw = await runGit(mainPath, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    return { repoPath, mainPath, commonDir, ...parseGitStatus(raw), progress: await progress(mainPath), error: null, claudeSessions: 0, terminalSessions: 0 }
  } catch (error) {
    return {
      repoPath, mainPath: null, commonDir: null, branch: null, head: '', upstream: null,
      ahead: 0, behind: 0, files: [], progress: null, error: gitError(error), claudeSessions: 0, terminalSessions: 0
    }
  }
}

async function preview(mainPath: string): Promise<ProjectGitPreview> {
  const status = await readStatus(mainPath)
  if (status.error) throw new Error(status.error)
  const staged = status.files.filter((f) => f.staged)
  const mode = staged.length ? 'staged' : 'all'
  const files = mode === 'staged' ? staged : status.files
  const raw = await runGit(mainPath, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  const token = createHash('sha256').update(mainPath).update(raw).digest('hex')
  return { mode, files, otherCount: status.files.length - files.length, token }
}

function commitWithStdin(cwd: string, message: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('git', ['-C', cwd, 'commit', '-F', '-'], {
      env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => child.kill(), NETWORK_TIMEOUT)
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part })
    child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part })
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) done()
      else fail(Object.assign(new Error(stderr || stdout || 'git commit failed'), { stderr: stderr || stdout }))
    })
    child.stdin.end(message)
  })
}

export interface GitMenuService {
  statuses(project: Project): Promise<ProjectGitStatus[]>
  branches(projectId: string, repoPath: string, discoverDefault?: boolean): Promise<ProjectGitBranch[]>
  preview(projectId: string, repoPath: string): Promise<ProjectGitPreview>
  action(projectId: string, repoPath: string, action: ProjectGitAction): Promise<string>
  commit(projectId: string, repoPath: string, token: string, message: string, push: boolean): Promise<ProjectGitCommitResult>
  validateName(projectId: string, repoPath: string, name: string): Promise<string | null>
}

export function createGitMenuService(getProject: (id: string) => Project | null | undefined, queue: RepoQueue, warningCounts?: (mainPath: string) => { claudeSessions: number; terminalSessions: number }): GitMenuService {
  async function binding(projectId: string, repoPath: string): Promise<ProjectGitStatus> {
    const project = getProject(projectId)
    if (!project?.repoPaths.includes(repoPath)) throw new Error('Repository is no longer bound to this project')
    const status = await readStatus(repoPath)
    if (status.error || !status.mainPath) throw new Error(status.error ?? 'Main checkout unavailable')
    return status
  }
  async function queued<T>(projectId: string, repoPath: string, job: (status: ProjectGitStatus) => Promise<T>): Promise<T> {
    const before = await binding(projectId, repoPath)
    return queue(before.mainPath!, async () => {
      const fresh = await binding(projectId, repoPath)
      if (fresh.commonDir !== before.commonDir || fresh.mainPath !== before.mainPath) throw new Error('Repository binding changed; refresh and try again')
      return job(fresh)
    })
  }
  async function checkName(mainPath: string, name: string): Promise<string | null> {
    if (!name.trim()) return 'Branch name is required'
    try { await runGit(mainPath, ['check-ref-format', '--branch', name]) }
    catch (error) { return gitError(error) }
    const exists = await runGit(mainPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false)
    return exists ? 'A local branch with this name already exists' : null
  }
  async function push(status: ProjectGitStatus): Promise<string> {
    if (!status.branch || !status.mainPath) throw new Error('Cannot push detached HEAD')
    const first = !status.upstream
    if (!first && status.ahead === 0) throw new Error('Nothing to push')
    await runGit(status.mainPath, first ? ['push', '-u', 'origin', status.branch] : ['push'], NETWORK_TIMEOUT)
    return first ? `Pushed ${status.branch} and set upstream origin/${status.branch}` : `Pushed ${status.branch}`
  }
  return {
    statuses: (project) => Promise.all(project.repoPaths.map(async (path) => {
      const status = await readStatus(path)
      return status.mainPath && warningCounts ? { ...status, ...warningCounts(status.mainPath) } : status
    })),
    branches: async (projectId, repoPath, discoverDefault = false) => {
      const status = await binding(projectId, repoPath)
      const main = status.mainPath!
      const raw = await runGit(main, ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin'])
      let defaultRemote = await runGit(main, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
        .then((value) => value.trim(), () => '')
      if (!defaultRemote && discoverDefault) {
        // A remote added to an existing checkout does not create origin/HEAD. The explicit New
        // branch dialog can ask origin which branch HEAD names without fetching any objects.
        const advertised = await runGit(main, ['ls-remote', '--symref', 'origin', 'HEAD'], NETWORK_TIMEOUT)
          .catch(() => '')
        const match = advertised.match(/^ref: refs\/heads\/([^\t\n]+)\tHEAD$/m)
        if (match) defaultRemote = `origin/${match[1]}`
      }
      const held = new Set(parseWorktreeList(await runGit(main, ['worktree', 'list', '--porcelain']))
        .filter((wt) => canon(wt.path) !== main && wt.branch).map((wt) => wt.branch))
      const local: ProjectGitBranch[] = []
      const remote: ProjectGitBranch[] = []
      const localNames = new Set<string>()
      for (const row of raw.trim().split('\n')) {
        const [ref, date] = row.split('\0')
        if (ref.startsWith('refs/heads/')) {
          const name = ref.slice(11)
          localNames.add(name)
          local.push({ name, kind: 'local', current: name === status.branch, inWorktree: held.has(name), timestamp: Number(date) || 0, defaultRemote: `origin/${name}` === defaultRemote })
        } else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
          remote.push({ name: ref.slice(13), kind: 'remote', current: false, inWorktree: false, timestamp: Number(date) || 0, defaultRemote: ref.slice(13) === defaultRemote })
        }
      }
      if (defaultRemote && !localNames.has(defaultRemote.slice(7)) && !remote.some((b) => b.name === defaultRemote)) {
        remote.push({ name: defaultRemote, kind: 'remote', current: false, inWorktree: false, timestamp: 0, defaultRemote: true })
      }
      local.sort((a, b) => Number(b.current) - Number(a.current) || b.timestamp - a.timestamp || a.name.localeCompare(b.name))
      return [...local, ...remote.filter((r) => !localNames.has(r.name.slice(7))).sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name))]
    },
    preview: async (projectId, repoPath) => preview((await binding(projectId, repoPath)).mainPath!),
    validateName: async (projectId, repoPath, name) => checkName((await binding(projectId, repoPath)).mainPath!, name),
    action: (projectId, repoPath, action) => queued(projectId, repoPath, async (status) => {
      const main = status.mainPath!
      if (action.kind !== 'fetch' && status.progress) throw new Error('Finish the Git operation in a terminal first')
      if (action.kind === 'fetch') {
        await runGit(main, ['fetch', '--prune'], NETWORK_TIMEOUT)
        return 'Fetched remote changes'
      }
      if (action.kind === 'pull') {
        if (!status.branch || !status.upstream) throw new Error('Pull needs an attached branch with an upstream')
        try { await runGit(main, ['pull', '--ff-only'], NETWORK_TIMEOUT) }
        catch (error) {
          if ((status.ahead && status.behind) || /diverg|not possible to fast-forward/i.test(gitError(error))) {
            throw new Error('Branch has diverged from origin. Merge or rebase in a terminal.')
          }
          throw error
        }
        return `Pulled into ${status.branch}`
      }
      if (action.kind === 'push') return push(status)
      if (action.kind === 'switch') {
        if (action.remote) {
          if (!action.branch.startsWith('origin/')) throw new Error('Invalid remote branch')
          const name = action.branch.slice(7)
          if (await checkName(main, name)) throw new Error('Local branch already exists')
          await runGit(main, ['switch', '--track', '-c', name, action.branch])
        } else {
          const branches = await runGit(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
          if (!branches.split('\n').includes(action.branch)) throw new Error('Branch no longer exists')
          await runGit(main, ['switch', action.branch])
        }
        return `Switched to ${action.branch}`
      }
      const invalid = await checkName(main, action.name)
      if (invalid) throw new Error(invalid)
      const start = action.start === 'HEAD' ? 'HEAD' : action.start
      if (start.startsWith('origin/')) {
        const remoteName = start.slice(7)
        if (!remoteName || remoteName === 'HEAD') throw new Error('Invalid remote start point')
        await runGit(main, ['fetch', 'origin', `refs/heads/${remoteName}:refs/remotes/origin/${remoteName}`], NETWORK_TIMEOUT)
      } else if (start !== 'HEAD') {
        const refs = await runGit(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
        if (!refs.split('\n').includes(start)) throw new Error('Start branch no longer exists')
      }
      await runGit(main, ['switch', '--no-track', '-c', action.name, start])
      return `Created and switched to ${action.name}`
    }),
    commit: (projectId, repoPath, token, message, doPush) => queued(projectId, repoPath, async (status) => {
      if (!message.trim()) throw new Error('Commit message is required')
      if (!status.branch || status.progress || !status.files.length) throw new Error('Commit is unavailable')
      const main = status.mainPath!
      const current = await preview(main)
      if (current.token !== token) return { outcome: 'preview-changed', preview: current }
      try {
        if (current.mode === 'all') await runGit(main, ['add', '-A'])
        await commitWithStdin(main, message)
      } catch (error) {
        return { outcome: 'failed', error: gitError(error), preview: await preview(main) }
      }
      const commit = (await runGit(main, ['rev-parse', '--short', 'HEAD'])).trim()
      if (doPush) {
        try { await push(await readStatus(main)) }
        catch (error) { return { outcome: 'committed-push-failed', commit, error: gitError(error) } }
      }
      return { outcome: 'committed', commit }
    })
  }
}
