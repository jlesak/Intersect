import { create } from 'zustand'
import type {
  DraftComment,
  FileDiff,
  NewManualDraft,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest
} from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** The stable `${repositoryId}:${prId}` key a PR is stored and selected under. */
export const prKey = (repositoryId: string, prId: number): string => `${repositoryId}:${prId}`

interface PrInboxState {
  status: Status
  error: string | null
  syncing: boolean
  prsByKey: Record<string, PullRequest>
  order: string[]
  selectedKey: string | null
  // The selected PR's loaded detail.
  changes: PrChangeFile[]
  activeFilePath: string | null
  fileDiff: FileDiff | null
  diffLoading: boolean
  threads: PrThread[]
  drafts: DraftComment[]
  review: { status: 'idle' | 'running' }
  // The live review session's accumulated PTY output, buffered here so the terminal can replay the
  // full history on remount and capture output emitted before (or while) the view is mounted.
  reviewOutput: string
  hydrate(): Promise<void>
  /** `quiet` suppresses the failure toast for automatic background syncs; user-initiated syncs
   * should stay loud so a broken sync is never silently ignored. */
  sync(opts?: { quiet?: boolean }): Promise<void>
  select(repositoryId: string, prId: number): Promise<void>
  openFile(path: string): Promise<void>
  addManualDraft(input: NewManualDraft): Promise<void>
  editDraft(id: string, body: string): Promise<void>
  discardDraft(id: string): Promise<void>
  publishDraft(id: string): Promise<void>
  /** Cast my vote on the selected PR; the state changes only once ADO has accepted the vote. */
  castVote(vote: PrVote): Promise<void>
  startReview(): Promise<void>
  endReview(): Promise<void>
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
  changes: [],
  activeFilePath: null,
  fileDiff: null,
  diffLoading: false,
  threads: [],
  drafts: [],
  review: { status: 'idle' },
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
      activeFilePath: null,
      fileDiff: null,
      diffLoading: false,
      threads: [],
      drafts: []
    })
    // Load the three sections independently so one failing call does not discard the others.
    const [changesR, draftsR, threadsR] = await Promise.allSettled([
      api.getChanges(repositoryId, prId),
      api.listDrafts(repositoryId, prId),
      api.getThreads(repositoryId, prId)
    ])
    // Ignore a stale response if the selection changed while awaiting; also suppress the error toast
    // for a PR the user has already left.
    if (get().selectedKey !== key) return
    const next: Partial<PrInboxState> = {}
    if (changesR.status === 'fulfilled') next.changes = changesR.value
    if (draftsR.status === 'fulfilled') next.drafts = draftsR.value
    if (threadsR.status === 'fulfilled') next.threads = threadsR.value
    set(next)
    const failed = [changesR, draftsR, threadsR].find((r) => r.status === 'rejected')
    if (failed && failed.status === 'rejected') {
      reportError('Could not load the pull request', failed.reason)
    }
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

  async addManualDraft(input) {
    try {
      const draft = await api.addManualDraft(input)
      // The main process also broadcasts draftAdded; upsert here so the UI updates immediately.
      set((s) => ({ drafts: upsertDraft(s.drafts, draft) }))
    } catch (e) {
      reportError('Could not add the comment', e)
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
      // Start the buffer clean so the new session's output is not appended to a prior one's.
      set({ review: { status: 'running' }, reviewOutput: '' })
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
      set({ review: { status: 'idle' }, reviewOutput: '' })
    }
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
    const offExit = api.onReviewExit(() => set({ review: { status: 'idle' } }))
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
