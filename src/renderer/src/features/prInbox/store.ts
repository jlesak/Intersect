import { create } from 'zustand'
import type {
  DraftComment,
  FileDiff,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest
} from '@common/domain'
import { boardColumn, isThreadUnresolved } from '@common/prBoard'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'
type ThreadFilter = 'active' | 'all' | 'resolved'

/** The stable `${repositoryId}:${prId}` key a PR is stored and selected under. */
export const prKey = (repositoryId: string, prId: number): string => `${repositoryId}:${prId}`

interface PrInboxState {
  status: Status
  error: string | null
  syncing: boolean
  prsByKey: Record<string, PullRequest>
  order: string[]
  selectedKey: string | null
  /** The main area shows the board, or the selected PR's detail. */
  view: 'board' | 'detail'
  activeTab: 'files' | 'overview'
  threadFilter: ThreadFilter
  /** File + line the Files tab should scroll to (set by Overview's file:line chip). */
  pendingReveal: { path: string; line: number | null } | null
  // The selected PR's loaded detail.
  changes: PrChangeFile[]
  /** Why the changed-files list could not load (e.g. no local clone), shown inline in the Files view. */
  changesError: string | null
  activeFilePath: string | null
  fileDiff: FileDiff | null
  diffLoading: boolean
  threads: PrThread[]
  /** Foreign PR threads load lazily (on first Overview open), so opening a PR stays cheap. */
  threadsLoaded: boolean
  drafts: DraftComment[]
  /**
   * In-progress inline reply/composer text keyed by a stable id (`reply:${threadId}` or
   * `composer:${path}:${line}`). Lifted out of the Monaco view-zone portals so recreating the
   * zones - which remounts every ThreadCard/composer when the anchor set changes - does not
   * discard unsent text.
   */
  commentDrafts: Record<string, string>
  review: { status: 'idle' | 'running' }
  /**
   * Which face of a running review the detail shows. Decoupled from `review.status` so the session
   * keeps running while the user reads the drafted changes and switches back to the terminal.
   */
  reviewView: 'terminal' | 'changes'
  /**
   * The `${repositoryId}:${prId}` key of the PR whose review session is live, or null. Survives
   * leaving the detail for the board, so the board can flag it and the user can return to the
   * running terminal.
   */
  reviewPrKey: string | null
  // The live review session's accumulated PTY output, buffered here so the terminal can replay the
  // full history on remount and capture output emitted before (or while) the view is mounted.
  reviewOutput: string
  hydrate(): Promise<void>
  /** `quiet` suppresses the failure toast for automatic background syncs; user-initiated syncs
   * should stay loud so a broken sync is never silently ignored. */
  sync(opts?: { quiet?: boolean }): Promise<void>
  select(repositoryId: string, prId: number): Promise<void>
  /** Open the PR's detail from the board (select + switch view). */
  openDetail(repositoryId: string, prId: number): Promise<void>
  /** Back to the board (breadcrumb or Esc). */
  goBack(): void
  setTab(tab: 'files' | 'overview'): void
  /** Fetch the selected PR's foreign threads once (idempotent); used on first Overview open. */
  loadThreads(): Promise<void>
  setThreadFilter(filter: ThreadFilter): void
  /**
   * Publish my own comment immediately; null path/line anchors it to the PR itself. Resolves to
   * true only when ADO accepted the write, so the caller can keep the composer open (preserving
   * the typed text) on failure instead of discarding it.
   */
  addComment(filePath: string | null, line: number | null, body: string): Promise<boolean>
  /** Resolves to true only when ADO accepted the reply, so the caller can keep the input on failure. */
  replyToThread(threadId: number, body: string): Promise<boolean>
  /** Resolves to true only when ADO accepted the status change. */
  setThreadStatus(threadId: number, status: 'active' | 'fixed'): Promise<boolean>
  /** Persist (or clear, when empty) the in-progress text for an inline reply/composer key. */
  setCommentDraft(key: string, text: string): void
  /** Jump from an Overview thread to its code: Files tab, open the file, scroll to the line. */
  revealThread(path: string, line: number | null): void
  clearReveal(): void
  openFile(path: string): Promise<void>
  editDraft(id: string, body: string): Promise<void>
  discardDraft(id: string): Promise<void>
  publishDraft(id: string): Promise<void>
  /** Cast my vote on the selected PR; the state changes only once ADO has accepted the vote. */
  castVote(vote: PrVote): Promise<void>
  startReview(): Promise<void>
  endReview(): Promise<void>
  /** Switch the running review's detail between the terminal and the drafted changes. */
  setReviewView(view: 'terminal' | 'changes'): void
  reviewInput(data: string): void
  reviewResize(cols: number, rows: number): void
  subscribe(): () => void
}

/** The PRs in sidebar order. */
export function selectPrList(state: PrInboxState): PullRequest[] {
  return state.order.map((k) => state.prsByKey[k]).filter(Boolean)
}

/** The currently selected PR, or undefined. */
export function selectSelectedPr(state: PrInboxState): PullRequest | undefined {
  return state.selectedKey ? state.prsByKey[state.selectedKey] : undefined
}

/** The drafts of the selected PR. */
export function selectDrafts(state: PrInboxState): DraftComment[] {
  return state.drafts
}

/**
 * The board's three columns, newest PRs first within each. A pure function over the list (not a
 * store selector) so components can memoize it - it returns fresh arrays on every call.
 */
export function groupBoardColumns(prs: PullRequest[]): {
  action: PullRequest[]
  waiting: PullRequest[]
  approved: PullRequest[]
} {
  const cols = {
    action: [] as PullRequest[],
    waiting: [] as PullRequest[],
    approved: [] as PullRequest[]
  }
  for (const pr of prs) cols[boardColumn(pr)].push(pr)
  for (const list of Object.values(cols)) list.sort((a, b) => b.createdAt - a.createdAt)
  return cols
}

/** The board's three columns computed from the store state (test seam over groupBoardColumns). */
export function selectBoardColumns(state: PrInboxState): {
  action: PullRequest[]
  waiting: PullRequest[]
  approved: PullRequest[]
} {
  return groupBoardColumns(selectPrList(state))
}

/** How many PRs currently need my action (the sidebar badge). */
export function selectActionCount(state: PrInboxState): number {
  return selectPrList(state).filter((pr) => boardColumn(pr) === 'action').length
}

/** Threads visible under the Overview filter; system threads never show. */
export function selectFilteredThreads(state: PrInboxState): PrThread[] {
  const real = state.threads.filter((t) => !t.isSystem)
  if (state.threadFilter === 'active') return real.filter(isThreadUnresolved)
  if (state.threadFilter === 'resolved') return real.filter((t) => !isThreadUnresolved(t))
  return real
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const indexPrs = (prs: PullRequest[]): { prsByKey: Record<string, PullRequest>; order: string[] } => {
  const prsByKey: Record<string, PullRequest> = {}
  const order: string[] = []
  for (const pr of prs) {
    const k = prKey(pr.repositoryId, pr.prId)
    prsByKey[k] = pr
    order.push(k)
  }
  return { prsByKey, order }
}

export const usePrInboxStore = create<PrInboxState>()((set, get) => ({
  status: 'idle',
  error: null,
  syncing: false,
  prsByKey: {},
  order: [],
  selectedKey: null,
  view: 'board',
  activeTab: 'files',
  threadFilter: 'active',
  pendingReveal: null,
  changes: [],
  changesError: null,
  activeFilePath: null,
  fileDiff: null,
  diffLoading: false,
  threads: [],
  threadsLoaded: false,
  drafts: [],
  commentDrafts: {},
  review: { status: 'idle' },
  reviewView: 'terminal',
  reviewPrKey: null,
  reviewOutput: '',

  async hydrate() {
    set({ status: 'loading', error: null })
    try {
      const prs = await api.list()
      set({ status: 'ready', ...indexPrs(prs) })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  async sync(opts) {
    set({ syncing: true })
    try {
      const prs = await api.sync()
      set({ status: 'ready', ...indexPrs(prs) })
    } catch (e) {
      if (opts?.quiet) console.warn('Background PR sync failed', e)
      else reportError('Could not sync pull requests', e)
    } finally {
      set({ syncing: false })
    }
  },

  async select(repositoryId, prId) {
    const key = prKey(repositoryId, prId)
    set({
      selectedKey: key,
      changes: [],
      changesError: null,
      activeFilePath: null,
      fileDiff: null,
      diffLoading: false,
      threads: [],
      threadsLoaded: false,
      drafts: [],
      commentDrafts: {}
    })
    // Load only what the Files view needs up front; foreign threads load lazily on Overview open.
    const [changesR, draftsR] = await Promise.allSettled([
      api.getChanges(repositoryId, prId),
      api.listDrafts(repositoryId, prId)
    ])
    // Ignore a stale response if the selection changed while awaiting; also suppress the error toast
    // for a PR the user has already left.
    if (get().selectedKey !== key) return
    const next: Partial<PrInboxState> = {}
    if (changesR.status === 'fulfilled') next.changes = changesR.value
    else next.changesError = message(changesR.reason)
    if (draftsR.status === 'fulfilled') next.drafts = draftsR.value
    set(next)
    // A missing local clone surfaces inline in the Files view (changesError); only a drafts failure
    // needs the toast here.
    if (draftsR.status === 'rejected') {
      reportError('Could not load the pull request', draftsR.reason)
    }
  },

  async openDetail(repositoryId, prId) {
    set({ view: 'detail', activeTab: 'files', threadFilter: 'active', pendingReveal: null })
    await get().select(repositoryId, prId)
  },

  goBack() {
    set({ view: 'board', selectedKey: null, pendingReveal: null })
  },

  setTab(tab) {
    set({ activeTab: tab })
    if (tab === 'overview' && !get().threadsLoaded) void get().loadThreads()
  },

  async loadThreads() {
    const pr = selectSelectedPr(get())
    if (!pr || get().threadsLoaded) return
    const key = get().selectedKey
    try {
      const threads = await api.getThreads(pr.repositoryId, pr.prId)
      // Drop a stale response if the user switched PRs while awaiting.
      if (get().selectedKey !== key) return
      set({ threads, threadsLoaded: true })
    } catch (e) {
      reportError('Could not load the pull request comments', e)
    }
  },

  setThreadFilter(threadFilter) {
    set({ threadFilter })
  },

  async addComment(filePath, line, body) {
    const pr = selectSelectedPr(get())
    if (!pr) return false
    try {
      const threads = await api.addComment({
        repositoryId: pr.repositoryId,
        prId: pr.prId,
        filePath,
        line,
        body
      })
      set({ threads })
      return true
    } catch (e) {
      reportError('Could not publish the comment to Azure DevOps', e)
      return false
    }
  },

  async replyToThread(threadId, body) {
    const pr = selectSelectedPr(get())
    if (!pr) return false
    try {
      const threads = await api.replyToThread(pr.repositoryId, pr.prId, threadId, body)
      set({ threads })
      return true
    } catch (e) {
      reportError('Could not publish the reply to Azure DevOps', e)
      return false
    }
  },

  async setThreadStatus(threadId, status) {
    const pr = selectSelectedPr(get())
    if (!pr) return false
    try {
      const threads = await api.setThreadStatus(pr.repositoryId, pr.prId, threadId, status)
      set({ threads })
      return true
    } catch (e) {
      reportError('Could not update the thread status', e)
      return false
    }
  },

  setCommentDraft(key, text) {
    set((s) => {
      if (!text) {
        if (!(key in s.commentDrafts)) return s
        const next = { ...s.commentDrafts }
        delete next[key]
        return { commentDrafts: next }
      }
      return { commentDrafts: { ...s.commentDrafts, [key]: text } }
    })
  },

  revealThread(path, line) {
    set({ activeTab: 'files', pendingReveal: { path, line } })
    void get().openFile(path)
  },

  clearReveal() {
    set({ pendingReveal: null })
  },

  async openFile(path) {
    const pr = selectSelectedPr(get())
    if (!pr) return
    const key = get().selectedKey
    set({ activeFilePath: path, fileDiff: null, diffLoading: true })
    try {
      const fileDiff = await api.getFileDiff(pr.repositoryId, pr.prId, path)
      // Drop the response if the user switched PRs or files while awaiting.
      if (get().selectedKey !== key || get().activeFilePath !== path) return
      set({ fileDiff, diffLoading: false })
    } catch (e) {
      set({ diffLoading: false })
      reportError('Could not load the file diff', e)
    }
  },

  async editDraft(id, body) {
    try {
      const draft = await api.editDraft(id, body)
      set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? draft : d)) }))
    } catch (e) {
      reportError('Could not edit the comment', e)
    }
  },

  async discardDraft(id) {
    try {
      await api.discardDraft(id)
      set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }))
    } catch (e) {
      reportError('Could not discard the comment', e)
    }
  },

  async publishDraft(id) {
    try {
      const draft = await api.publishDraft(id)
      set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? draft : d)) }))
    } catch (e) {
      reportError('Could not publish the comment to Azure DevOps', e)
    }
  },

  async castVote(vote) {
    const pr = selectSelectedPr(get())
    if (!pr) return
    try {
      const updated = await api.castVote(pr.repositoryId, pr.prId, vote)
      set((s) => ({
        prsByKey: { ...s.prsByKey, [prKey(updated.repositoryId, updated.prId)]: updated }
      }))
    } catch (e) {
      reportError('Could not cast vote', e)
    }
  },

  async startReview() {
    const pr = selectSelectedPr(get())
    if (!pr) return
    try {
      await api.startReview(pr.repositoryId, pr.prId)
      // Start the buffer clean so the new session's output is not appended to a prior one's, and
      // open on the terminal; the drafts view is one toggle away.
      set({
        review: { status: 'running' },
        reviewPrKey: prKey(pr.repositoryId, pr.prId),
        reviewView: 'terminal',
        reviewOutput: ''
      })
    } catch (e) {
      reportError('Could not start the review session', e)
    }
  },

  async endReview() {
    try {
      await api.endReview()
    } catch (e) {
      reportError('Could not end the review session', e)
    } finally {
      set({ review: { status: 'idle' }, reviewPrKey: null, reviewView: 'terminal', reviewOutput: '' })
    }
  },

  setReviewView(view) {
    set({ reviewView: view })
  },

  reviewInput(data) {
    api.reviewInput(data)
  },

  reviewResize(cols, rows) {
    api.reviewResize(cols, rows)
  },

  subscribe() {
    // A draft recorded by the live review session (or manually) is pushed from main; merge it into
    // the selected PR's drafts so it appears without a manual refresh.
    const offDraft = api.onDraftAdded((draft) => {
      const pr = selectSelectedPr(get())
      if (!pr || pr.repositoryId !== draft.repositoryId || pr.prId !== draft.prId) return
      set((s) => ({ drafts: upsertDraft(s.drafts, draft) }))
    })
    // Buffer review PTY output here (subscribe runs once at module scope, before any review is
    // started) so nothing emitted before the terminal mounts - including the initial banner - is lost.
    const offData = api.onReviewData((data) => set((s) => ({ reviewOutput: s.reviewOutput + data })))
    const offExit = api.onReviewExit(() => set({ review: { status: 'idle' }, reviewPrKey: null }))
    return () => {
      offDraft()
      offData()
      offExit()
    }
  }
}))

/** Insert the draft, or replace the existing row with the same id. */
function upsertDraft(drafts: DraftComment[], draft: DraftComment): DraftComment[] {
  return drafts.some((d) => d.id === draft.id)
    ? drafts.map((d) => (d.id === draft.id ? draft : d))
    : [...drafts, draft]
}
