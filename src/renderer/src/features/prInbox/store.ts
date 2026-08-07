import type {
  DraftComment,
  FileDiff,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest
} from '@common/domain'
import { boardColumn, isThreadUnresolved } from '@common/prBoard'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'
type ThreadFilter = 'active' | 'all' | 'resolved'

/**
 * How old the board's data may be before an automatic refresh is worth what it costs.
 *
 * One sync is one Azure DevOps call per repository plus one thread fetch per open pull request, so
 * refreshing on every trigger would fire that whole fan-out each time the user glances away at
 * their editor or opens another section. Five minutes is short enough that a board being read is
 * effectively live, and long enough that alt-tabbing costs nothing.
 */
const STALE_AFTER_MS = 5 * 60 * 1000

/** The stable `${repositoryId}:${prId}` key a PR is stored and selected under. */
export const prKey = (repositoryId: string, prId: number): string => `${repositoryId}:${prId}`

interface PrInboxState {
  status: Status
  error: string | null
  syncing: boolean
  prsByKey: Record<string, PullRequest>
  order: string[]
  /**
   * When the cached board was last refreshed from Azure DevOps, or null when it never has been.
   * Read from the cache rather than stamped locally, so freshness survives a restart instead of
   * reading as unknown at exactly the moment the board is most likely to be stale.
   */
  syncedAt: number | null
  /**
   * Why the latest refresh from Azure DevOps failed, or null when it succeeded. Describes only the
   * most recent attempt, so the board can admit it is showing cached data without ever hiding that
   * data behind an error state.
   */
  syncError: string | null
  /**
   * Whether Azure DevOps can be reached at all, as far as the saved settings are concerned.
   *
   * Mirrored in by the app layer rather than read from the settings slice directly: a feature store
   * reaching into another feature's barrel to answer this drags that feature's whole UI into this
   * one's module graph, and here it closed a cycle back onto this very file. False until the app
   * layer says otherwise, so a connection that is not yet known is never mistaken for one that
   * exists.
   */
  adoConnected: boolean
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
  /** Whether the selected PR's foreign threads have been fetched, so no open refetches them. */
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
  /**
   * Refresh from Azure DevOps only when it is worth reaching for the network: there is a connection
   * to reach it with, the board's data is old enough to doubt (or was never fetched), and no
   * refresh is already running. Otherwise does nothing.
   *
   * Every automatic trigger goes through this one guard, so no two of them can disagree about when
   * the board is stale or fire a second fan-out seconds after the first. The refresh is always
   * quiet, because a machine that is merely offline must not interrupt the user over a sync they
   * never asked for. Anything the user does ask for calls `sync` directly and loudly.
   */
  syncIfStale(): Promise<void>
  /** Record whether Azure DevOps is reachable, so the guard above can consult it. */
  setAdoConnected(connected: boolean): void
  select(repositoryId: string, prId: number): Promise<void>
  /** Open the PR's detail from the board (select + switch view). */
  openDetail(repositoryId: string, prId: number): Promise<void>
  /** Back to the board (breadcrumb or Esc). */
  goBack(): void
  /**
   * Show the selected PR on Azure DevOps itself, for the parts of a review this app does not model
   * (policies, work items, the full iteration history). Does nothing for a PR whose web link the
   * server never gave us.
   */
  openInBrowser(): void
  /** Put the selected PR's web link on the clipboard, to paste into a chat or a work item. */
  copyLink(): Promise<void>
  setTab(tab: 'files' | 'overview'): void
  /** Fetch the selected PR's foreign threads once (idempotent). */
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
 * The board's three columns, most recently active PRs first within each, so a review queue is
 * ordered by what needs attention rather than by what happens to be oldest. A pure function over
 * the list (not a store selector) so components can memoize it - it returns fresh arrays on every
 * call.
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
  for (const list of Object.values(cols)) list.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return cols
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

/**
 * Refresh the board's freshness stamp. A failure to read it leaves the previous value in place and
 * says nothing: the board itself is fine, and a slice of supporting metadata must never be able to
 * turn a working inbox into an error state.
 */
async function readSyncedAt(set: (partial: Partial<PrInboxState>) => void): Promise<void> {
  try {
    set({ syncedAt: await api.getSyncedAt() })
  } catch {
    // Deliberately silent - see above.
  }
}

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

export const usePrInboxStore = createStore<PrInboxState>()((set, get) => ({
  status: 'idle',
  error: null,
  syncing: false,
  prsByKey: {},
  order: [],
  syncedAt: null,
  syncError: null,
  adoConnected: false,
  selectedKey: null,
  view: 'board',
  activeTab: 'overview',
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
    // Both reads start together, since neither waits on the other.
    const stamp = readSyncedAt(set)
    let board: Partial<PrInboxState>
    try {
      board = { status: 'ready', ...indexPrs(await api.list()) }
    } catch (e) {
      board = { status: 'error', error: message(e) }
    }
    // The freshness stamp is in place before the board reports what it holds. Whoever reacts to a
    // ready board judges its freshness from that stamp, so a stamp still in flight would read as a
    // board that has never synced at all, however fresh the cache actually is.
    await stamp
    set(board)
  },

  async sync(opts) {
    set({ syncing: true })
    try {
      const prs = await api.sync()
      set({ status: 'ready', syncError: null, ...indexPrs(prs) })
      await readSyncedAt(set)
    } catch (e) {
      // The cached board is left as it is: a refresh that failed still leaves data worth acting on.
      set({ syncError: message(e) })
      if (opts?.quiet) console.warn('Background PR sync failed', e)
      else reportError('Could not sync pull requests', e)
    } finally {
      set({ syncing: false })
    }
  },

  async syncIfStale() {
    const { adoConnected, syncing, syncedAt } = get()
    if (!adoConnected) return
    if (syncing) return
    if (syncedAt !== null && Date.now() - syncedAt < STALE_AFTER_MS) return

    await get().sync({ quiet: true })
  },

  setAdoConnected(connected) {
    set({ adoConnected: connected })
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
    // The changed files and the drafts are all this needs; the threads are the caller's to fetch.
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
    set({ view: 'detail', activeTab: 'overview', threadFilter: 'active', pendingReveal: null })
    await get().select(repositoryId, prId)
    // The threads belong to the whole detail, not to the conversation tab: the diff renders them
    // inline too, so fetching them only when the conversation is opened leaves a reader who went
    // straight to the code looking at a diff that claims nobody has commented on it.
    await get().loadThreads()
  },

  goBack() {
    set({ view: 'board', selectedKey: null, pendingReveal: null })
  },

  openInBrowser() {
    const url = selectSelectedPr(get())?.url
    if (!url) return
    api.openExternal(url).catch((e) => reportError('Could not open the pull request', e))
  },

  async copyLink() {
    const url = selectSelectedPr(get())?.url
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
    } catch (e) {
      reportError('Could not copy the pull request link', e)
    }
  },

  setTab(tab) {
    set({ activeTab: tab })
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
