import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { Project, RepoWorktrees, WorktreeInfo } from '@common/domain'
import { git, gitRaw } from '../prInbox/git'
import { canonicalizePath } from './paths'

type Entry = Pick<WorktreeInfo, 'path' | 'head' | 'branch' | 'bare' | 'lockedReason' | 'prunableReason'>

/** Git's -z worktree format uses NULs for both attributes and stanza separators. */
export function parseWorktreeList(porcelain: string): Entry[] {
  const entries: Entry[] = []
  const fields = porcelain.split(porcelain.includes('\0') ? '\0' : '\n')
  let current: Entry | null = null
  const flush = (): void => {
    if (current) entries.push(current)
    current = null
  }
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      flush()
      current = {
        path: field.slice(9), head: '', branch: null, bare: false,
        lockedReason: null, prunableReason: null
      }
    } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5)
    else if (current && field.startsWith('branch ')) {
      current.branch = field.slice(7).replace(/^refs\/heads\//, '')
    } else if (current && field === 'bare') current.bare = true
    else if (current && field.startsWith('locked')) {
      current.lockedReason = field === 'locked' ? '' : field.slice(7)
    } else if (current && field.startsWith('prunable')) {
      current.prunableReason = field === 'prunable' ? '' : field.slice(9)
    }
  }
  flush()
  return entries
}

export function parseChangedFiles(porcelain: string): WorktreeInfo['changed'] {
  const fields = porcelain.split('\0')
  const changed: WorktreeInfo['changed'] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    if (code.includes('R') || code.includes('C')) {
      const oldPath = fields[++i]
      changed.push({ code, path: `${oldPath} -> ${path}` })
    } else {
      changed.push({ code, path })
    }
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
}

export async function worktreeCreatedAt(commonDir: string, worktreePath: string): Promise<number | null> {
  const adminRoot = join(commonDir, 'worktrees')
  const target = canonicalizePath(worktreePath)
  let names: string[]
  try {
    names = await readdir(adminRoot)
  } catch {
    return null
  }
  for (const name of names) {
    const admin = join(adminRoot, name)
    try {
      const pointer = (await readFile(join(admin, 'gitdir'), 'utf8')).trim()
      if (canonicalizePath(dirname(pointer)) !== target) continue
      const birth = (await stat(admin)).birthtimeMs
      return Number.isFinite(birth) && birth > 0 ? birth : null
    } catch {
      // An unrelated or damaged admin entry cannot hide a healthy worktree.
    }
  }
  return null
}

export function sortWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return [...worktrees].sort((a, b) =>
    Number(b.main) - Number(a.main) ||
    (b.createdAt ?? -1) - (a.createdAt ?? -1) ||
    a.path.localeCompare(b.path)
  )
}

export function containsFolder(parent: string, child: string): boolean {
  const a = canonicalizePath(parent)
  const b = canonicalizePath(child)
  return b === a || b.startsWith(`${a}${sep}`)
}

async function inspectEntry(
  repoPath: string,
  commonDir: string,
  entry: Entry,
  mainPath: string,
  userDataDir?: string
): Promise<WorktreeInfo> {
  const main = canonicalizePath(entry.path) === canonicalizePath(mainPath)
  const missing = entry.prunableReason !== null
  const changed = entry.bare || missing ? [] :
    parseChangedFiles(await gitRaw(entry.path, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no',
      '--ignore-submodules=none'
    ]))
  const unpushed = entry.branch ?
    Number(await git(repoPath, ['rev-list', '--count', `refs/heads/${entry.branch}`, '--not', '--remotes'])) : 0
  const goneOnOrigin = entry.branch ?
    (await git(repoPath, ['for-each-ref', '--format=%(upstream:track)',
      `refs/heads/${entry.branch}`])).includes('[gone]') : false
  const canonical = canonicalizePath(entry.path)
  const managed = userDataDir
    ? containsFolder(join(userDataDir, 'pr-review-worktrees'), canonical) ? 'review'
      : containsFolder(join(userDataDir, 'pr-fix-worktrees'), canonical) ? 'fix' : null
    : null
  return {
    ...entry,
    displayPath: displayWorktreePath(repoPath, entry.path),
    main,
    createdAt: main ? null : await worktreeCreatedAt(commonDir, entry.path),
    changed,
    unpushed,
    goneOnOrigin,
    managed,
    workspaces: []
  }
}

/** Each binding fails inline, without hiding other repositories in the project. */
export async function listProjectWorktrees(
  project: Project,
  options: {
    userDataDir?: string
    onRepo?: <T>(repoPath: string, job: () => Promise<T>) => Promise<T>
    enrich?: (worktree: WorktreeInfo) => WorktreeInfo
  } = {}
): Promise<RepoWorktrees[]> {
  return Promise.all(project.repoPaths.map(async (repoPath): Promise<RepoWorktrees> => {
    try {
      const work = async (): Promise<RepoWorktrees> => {
        const commonDir = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const entries = parseWorktreeList(await gitRaw(repoPath, ['worktree', 'list', '--porcelain', '-z']))
        const mainPath = entries[0]?.path ?? repoPath
        const worktrees = await Promise.all(entries.map(async (entry) => {
          const info = await inspectEntry(repoPath, commonDir, entry, mainPath, options.userDataDir)
          return options.enrich ? options.enrich(info) : info
        }))
        return { repoPath, worktrees: sortWorktrees(worktrees), error: null }
      }
      return options.onRepo ? await options.onRepo(repoPath, work) : await work()
    } catch (err) {
      return { repoPath, worktrees: [], error: err instanceof Error ? err.message : String(err) }
    }
  }))
}

/** Relative inside the bound repository; abbreviate only this user's actual home elsewhere. */
export function displayWorktreePath(
  repoPath: string, worktreePath: string, homePath = homedir()
): string {
  const target = canonicalizePath(worktreePath)
  const rel = relative(canonicalizePath(repoPath), target)
  if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return rel
  const home = canonicalizePath(homePath)
  if (target === home) return '~'
  if (target.startsWith(`${home}${sep}`)) return `~${target.slice(home.length)}`
  return worktreePath
}
