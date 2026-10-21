import type { FixWorktreeClosedEvent, PrFixLaunch, PullRequest } from '@common/domain'
import type { Logger } from '@common/logging/logger'
import { selectFixThreads } from '@common/prFix'
import { canonicalizePath } from '../projects/paths'
import type { SessionManager } from '../pty/sessionManager'
import type { AdoService } from './adoService'
import { buildFixPrompt } from './fixPrompt'
import {
  fixWorktreePath,
  isFixWorktreePath,
  selectOrphanFixFolders,
  sourceBranch,
  type WorktreeManager
} from './worktreeManager'

/** How long a closed fix tab's session gets to exit before its worktree is left alone. */
export const FIX_SESSION_EXIT_TIMEOUT_MS = 10_000

export interface FixManagerDeps {
  userDataDir: string
  ado: Pick<AdoService, 'getThreads'>
  worktrees: Pick<
    WorktreeManager,
    'resolveRepoDir' | 'createBranchWorktree' | 'removeCleanWorktree' | 'listFixFolders'
  >
  sessions: Pick<SessionManager, 'whenWorkspaceExited'>
  /** Every workspace folder; fix worktrees among them are skipped when looking for the clone. */
  workspaceFolders: () => string[]
  /** Whether any workspace on this (canonical) folder still has a tab. */
  hasOpenTabs: (path: string) => boolean
  /** Delete the workspace in one transaction, only when it still has no tab; true when deleted. */
  removeWorkspaceIfEmpty: (workspaceId: string) => boolean
  /** How a cleanup ended, for the app to show or to drop the workspace. */
  onClosed: (event: FixWorktreeClosedEvent) => void
  logger?: Pick<Logger, 'warn' | 'info'>
}

export interface FixManager {
  /**
   * Prepare fixing the review comments of my pull request: its worktree on the source branch,
   * and Claude's first message parked for the tab that opens there. When a tab is already open in
   * that worktree nothing is created and the app only focuses it.
   */
  start(pr: PullRequest): Promise<PrFixLaunch>
  /** The parked first message for this folder, handed out once. */
  takePrompt(cwd: string): string | null
  isFixFolder(path: string): boolean
  /**
   * The last tab of a fix workspace closed: once its session has exited, remove the worktree when
   * clean, then the workspace. Runs in the background and reports through `onClosed`.
   */
  scheduleClose(workspaceId: string, folderPath: string): void
  /**
   * The boot sweep: remove each fix worktree an earlier run left behind with no workspace on it,
   * when clean. A dirty or unrecognised folder is kept and logged. Never rejects per folder.
   */
  pruneOrphans(): Promise<void>
}

const prKeyOf = (pr: PullRequest): string => `${pr.repositoryId}:${pr.prId}`

export function createFixManager(d: FixManagerDeps): FixManager {
  const isFixFolder = (path: string): boolean => isFixWorktreePath(d.userDataDir, path)
  // Keyed by canonical folder, which is how the session manager will ask for it.
  const prompts = new Map<string, string>()
  // Synchronous guard per pull request: a double click must not race two worktree creations.
  const starting = new Set<string>()
  // The cleanup running for each folder, a close or the boot sweep, so a start waits for it
  // instead of racing the removal.
  const closing = new Map<string, Promise<void>>()
  // Every folder a start of this session worked on. Its worktree is this session's, never an
  // orphan, even before the workspace for it exists.
  const startedHere = new Set<string>()
  // The cleanup of each folder that is still waiting for sessions to exit, not yet removing.
  const waiting = new Map<string, { workspaceId: string; again: boolean }>()

  async function prepare(pr: PullRequest): Promise<PrFixLaunch> {
    const threads = selectFixThreads(pr, await d.ado.getThreads(pr.repositoryId, pr.prId))
    if (threads.length === 0) throw new Error('No open reviewer comments on this pull request.')

    const path = fixWorktreePath(d.userDataDir, pr)
    startedHere.add(path)
    await closing.get(path)
    if (d.hasOpenTabs(path)) return { worktreePath: path, alreadyOpen: true }

    const branch = sourceBranch(pr.sourceRefName)
    const clones = d.workspaceFolders().filter((folder) => !isFixFolder(folder))
    const repoDir = await d.worktrees.resolveRepoDir(pr.repositoryName, clones)
    const { diverged } = await d.worktrees.createBranchWorktree({ repoDir, path, branch })
    prompts.set(path, buildFixPrompt(pr, threads, { name: branch, diverged }))
    return { worktreePath: path, alreadyOpen: false }
  }

  async function close(workspaceId: string, path: string): Promise<void> {
    const report = (
      outcome: FixWorktreeClosedEvent['outcome'],
      workspaceRemoved: boolean,
      detail: string | null
    ): void => d.onClosed({ workspaceId, path, outcome, workspaceRemoved, detail })

    // Removing files a killed session is still writing would half-delete the folder, so the
    // removal only starts once the PTY has really gone. At least twice: a wait only knows the
    // sessions alive when it began, so a tab opened and closed again meanwhile has its own PTY
    // waited for by the next one. A close of the same workspace arriving while this run still
    // waits is folded in as one more wait instead of a second cleanup queued behind this one.
    const phase = { workspaceId, again: false }
    waiting.set(path, phase)
    try {
      for (let pass = 0; pass < 2 || phase.again; pass++) {
        phase.again = false
        const exit = await d.sessions.whenWorkspaceExited(workspaceId, FIX_SESSION_EXIT_TIMEOUT_MS)
        if (exit === 'timeout') return report('busy', false, null)
        // A tab opened in the meantime means the user is working there again.
        if (d.hasOpenTabs(path)) return
      }
    } finally {
      waiting.delete(path)
    }

    const result = await d.worktrees.removeCleanWorktree(path)
    if (result.outcome !== 'removed') return report(result.outcome, false, result.detail)
    prompts.delete(path)
    report('removed', d.removeWorkspaceIfEmpty(workspaceId), null)
  }

  /** Run cleanup work on a folder after the one already running there; a start waits for it. */
  function queueOn(path: string, work: () => Promise<void>, data: object): Promise<void> {
    const previous = closing.get(path) ?? Promise.resolve()
    const run = previous.then(work).catch((err: unknown) => {
      d.logger?.warn('fix worktree cleanup failed', { data: { ...data, path }, err })
    })
    closing.set(path, run)
    void run.then(() => {
      if (closing.get(path) === run) closing.delete(path)
    })
    return run
  }

  async function sweepOrphan(path: string): Promise<void> {
    // Checked again now rather than only when listing: a workspace may have been made on the
    // folder, or a start may have reused it, since.
    if (startedHere.has(path)) return
    if (selectOrphanFixFolders([path], d.workspaceFolders()).length === 0) return
    const result = await d.worktrees.removeCleanWorktree(path)
    if (result.outcome === 'removed') {
      d.logger?.info('orphaned fix worktree removed', { data: { path } })
      return
    }
    d.logger?.warn('orphaned fix worktree kept', {
      data: { path, outcome: result.outcome, detail: result.detail }
    })
  }

  return {
    async start(pr) {
      if (pr.role !== 'author') {
        throw new Error('Only your own pull requests can have their review comments fixed.')
      }
      const key = prKeyOf(pr)
      if (starting.has(key)) throw new Error('A fix for this pull request is already starting.')
      starting.add(key)
      try {
        return await prepare(pr)
      } finally {
        starting.delete(key)
      }
    },

    takePrompt(cwd) {
      const key = canonicalizePath(cwd)
      const prompt = prompts.get(key) ?? null
      prompts.delete(key)
      return prompt
    },

    isFixFolder,

    scheduleClose(workspaceId, folderPath) {
      if (!isFixFolder(folderPath)) return
      const path = canonicalizePath(folderPath)
      const waitingRun = waiting.get(path)
      if (waitingRun?.workspaceId === workspaceId) {
        waitingRun.again = true
        return
      }
      void queueOn(path, () => close(workspaceId, path), { workspaceId })
    },

    async pruneOrphans() {
      const orphans = selectOrphanFixFolders(
        await d.worktrees.listFixFolders(),
        d.workspaceFolders()
      )
      // One folder at a time, each registered as that folder's cleanup only when its turn comes:
      // a start for a folder still waiting its turn is recorded in `startedHere` and skipped.
      for (const path of orphans) await queueOn(path, () => sweepOrphan(path), {})
    }
  }
}
