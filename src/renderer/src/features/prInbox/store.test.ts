import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  DraftComment,
  PrChangeFile,
  PrThread,
  PullRequest,
  ReviewSession
} from '@common/domain'
import type { ReviewDataEvent, ReviewExitEvent } from '@common/ipc'
import { captureRendererLog } from '@renderer/shared/logging/testLog'

vi.mock('./ipc')
import * as api from './ipc'
import { appendReviewOutput, readReviewOutput, resetReviewOutput } from './reviewOutput'
import {
  groupBoardColumns,
  prKey,
  selectDrafts,
  selectPrList,
  selectSelectedPr,
  selectSelectedReviewSessionId,
  splitThreadsByResolution,
  usePrInboxStore
} from './store'

/** Push one broadcast into whatever `subscribe()` registered, the way main would. */
const emitReviewData = (msg: ReviewDataEvent): void => {
  for (const [cb] of mocked.onReviewData.mock.calls) cb(msg)
}
const emitReviewExit = (msg: ReviewExitEvent): void => {
  for (const [cb] of mocked.onReviewExit.mock.calls) cb(msg)
}

const pr = (repositoryId: string, prId: number, over: Partial<PullRequest> = {}): PullRequest => ({
  prId,
  repositoryId,
  repositoryName: repositoryId,
  projectId: 'proj',
  title: `PR ${prId}`,
  description: '',
  authorId: 'u1',
  authorName: 'Author',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'src',
  targetCommitId: 'tgt',
  url: 'https://ado/pr',
  role: 'reviewer',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 0,
  ...over
})

const draft = (id: string, over: Partial<DraftComment> = {}): DraftComment => ({
  id,
  prId: 1,
  repositoryId: 'repo',
  filePath: 'a.ts',
  line: 3,
  side: 'right',
  body: 'body',
  status: 'pending',
  source: 'manual',
  reviewSessionId: null,
  sourceCommitId: 'src',
  publishedThreadId: null,
  createdAt: 0,
  ...over
})

const change = (path: string): PrChangeFile => ({
  path,
  changeType: 'edit',
  originalPath: null,
  added: 1,
  removed: 1
})
const thread = (threadId: number, over: Partial<PrThread> = {}): PrThread => ({
  threadId,
  filePath: 'a.ts',
  line: 1,
  status: 'active',
  isSystem: false,
  comments: [],
  ...over
})

const mocked = vi.mocked(api)

/** Every record the store shipped during the current test. */
let logged: Array<Record<string, unknown>> = []

/** Whether the log carries one record under the given message. */
const loggedOnce = (msg: string): boolean => logged.filter((r) => r.msg === msg).length === 1

beforeEach(() => {
  usePrInboxStore.setState(
    {
      status: 'idle',
      error: null,
      syncing: false,
      syncError: null,
      prsByKey: {},
      order: [],
      syncedAt: null,
      selectedKey: null,
      changes: [],
      changesError: null,
      activeFilePath: null,
      fileDiff: null,
      diffLoading: false,
      threads: [],
      threadsLoaded: false,
      threadsError: null,
      drafts: [],
      draftsStatus: 'idle',
      draftsError: null,
      unfinishedReviews: {},
      unfinishedReviewsStatus: 'idle',
      unfinishedReviewsError: null,
      commentDrafts: {},
      liveReviews: {},
      reviewViews: {},
      view: 'board',
      activeTab: 'overview',
      pendingReveal: null
    },
    false
  )
  vi.clearAllMocks()
  mocked.listUnfinishedDraftReviews.mockResolvedValue([])
  mocked.listActiveReviews.mockResolvedValue([])
  logged = captureRendererLog()
})

describe('prInboxStore', () => {
  test('hydrate loads the cached PRs and is ready', async () => {
    mocked.list.mockResolvedValue([pr('repo', 1), pr('repo', 2)])
    await usePrInboxStore.getState().hydrate()
    const s = usePrInboxStore.getState()
    expect(s.status).toBe('ready')
    expect(selectPrList(s).map((p) => p.prId)).toEqual([1, 2])
  })

  test('hydrate reads how fresh the cached board is', async () => {
    mocked.list.mockResolvedValue([])
    mocked.getSyncedAt.mockResolvedValue(1_700_000_000_000)
    await usePrInboxStore.getState().hydrate()
    expect(usePrInboxStore.getState().syncedAt).toBe(1_700_000_000_000)
  })

  test('hydrate has the freshness stamp in hand by the time it reports the board ready', async () => {
    mocked.list.mockResolvedValue([pr('repo', 1)])
    // The stamp is held back until after the cached board has arrived, since two IPC round trips
    // land in whatever order they please and the slower one must still be waited for.
    let deliverStamp: (at: number | null) => void = () => {}
    mocked.getSyncedAt.mockReturnValue(
      new Promise<number | null>((resolve) => {
        deliverStamp = resolve
      })
    )
    let stampWhenReady: number | null | undefined
    const off = usePrInboxStore.subscribe((s) => {
      if (s.status === 'ready' && stampWhenReady === undefined) stampWhenReady = s.syncedAt
    })

    const hydrated = usePrInboxStore.getState().hydrate()
    deliverStamp(1_700_000_000_000)
    await hydrated
    off()

    // Anything that acts on a ready board judges its freshness from this value, so a null here is
    // a board that reads as never synced however fresh the cache actually is.
    expect(stampWhenReady).toBe(1_700_000_000_000)
  })

  test('a sync refreshes the freshness stamp', async () => {
    mocked.sync.mockResolvedValue([pr('repo', 7)])
    mocked.getSyncedAt.mockResolvedValue(42)
    await usePrInboxStore.getState().sync()
    expect(usePrInboxStore.getState().syncedAt).toBe(42)
  })

  test('an unreadable freshness stamp leaves the previous value and the board intact', async () => {
    usePrInboxStore.setState({ syncedAt: 7 })
    mocked.list.mockResolvedValue([pr('repo', 1)])
    mocked.getSyncedAt.mockRejectedValue(new Error('channel gone'))
    await usePrInboxStore.getState().hydrate()
    expect(usePrInboxStore.getState().status).toBe('ready')
    expect(usePrInboxStore.getState().syncedAt).toBe(7)
  })

  test('hydrate sets error status when the IPC call fails', async () => {
    mocked.list.mockRejectedValue(new Error('cache gone'))
    await usePrInboxStore.getState().hydrate()
    expect(usePrInboxStore.getState().status).toBe('error')
    expect(usePrInboxStore.getState().error).toMatch(/cache gone/)
  })

  test('hydrate restores unfinished review counts independently of opening a PR', async () => {
    mocked.list.mockResolvedValue([pr('repo', 1)])
    mocked.listUnfinishedDraftReviews.mockResolvedValue([
      { repositoryId: 'repo', prId: 1, remainingDraftCount: 2 }
    ])

    await usePrInboxStore.getState().hydrate()

    expect(usePrInboxStore.getState().unfinishedReviews).toEqual({ 'repo:1': 2 })
    expect(usePrInboxStore.getState().unfinishedReviewsStatus).toBe('ready')
  })

  test('hydrate rebinds to the reviews main is still running', async () => {
    // A window reload resets this store while main keeps every PTY, so what is running there is
    // the truth about which pull requests are busy.
    mocked.list.mockResolvedValue([pr('repo', 1), pr('repo', 2)])
    mocked.listActiveReviews.mockResolvedValue([
      {
        id: 'rs-9',
        prId: 2,
        repositoryId: 'repo',
        repoDir: '/clone',
        worktreePath: '/wt',
        status: 'running',
        createdAt: 0
      }
    ])

    await usePrInboxStore.getState().hydrate()

    expect(usePrInboxStore.getState().liveReviews).toEqual({ 'repo:2': 'rs-9' })
  })

  test('a failed live-review read leaves the badges off rather than inventing sessions', async () => {
    mocked.list.mockResolvedValue([pr('repo', 1)])
    mocked.listActiveReviews.mockRejectedValue(new Error('main is not answering'))

    await usePrInboxStore.getState().hydrate()

    expect(usePrInboxStore.getState().liveReviews).toEqual({})
    expect(usePrInboxStore.getState().status).toBe('ready')
  })

  test('an unfinished-review load failure is not represented as zero drafts', async () => {
    mocked.list.mockResolvedValue([pr('repo', 1)])
    mocked.listUnfinishedDraftReviews.mockRejectedValue(new Error('draft database unavailable'))

    await usePrInboxStore.getState().hydrate()

    const state = usePrInboxStore.getState()
    expect(state.status).toBe('ready')
    expect(state.unfinishedReviewsStatus).toBe('error')
    expect(state.unfinishedReviewsError).toContain('draft database unavailable')
  })

  test('sync populates the list and clears the syncing flag', async () => {
    mocked.sync.mockResolvedValue([pr('repo', 7)])
    await usePrInboxStore.getState().sync()
    const s = usePrInboxStore.getState()
    expect(s.syncing).toBe(false)
    expect(s.order).toEqual([prKey('repo', 7)])
    expect(s.prsByKey[prKey('repo', 7)].prId).toBe(7)
  })

  test('a quiet sync failure warns without toasting and clears the syncing flag', async () => {
    mocked.sync.mockRejectedValue(new Error('ADO not configured'))
    await usePrInboxStore.getState().sync({ quiet: true })
    expect(usePrInboxStore.getState().syncing).toBe(false)
    expect(loggedOnce('background PR sync failed')).toBe(true)
  })

  test('a quiet sync failure records why, and keeps the cached board', async () => {
    usePrInboxStore.setState({
      status: 'ready',
      prsByKey: { [prKey('repo', 5)]: pr('repo', 5) },
      order: [prKey('repo', 5)]
    })
    mocked.sync.mockRejectedValue(new Error('getaddrinfo ENOTFOUND dev.azure.com'))
    await usePrInboxStore.getState().sync({ quiet: true })
    const s = usePrInboxStore.getState()
    expect(s.syncError).toMatch(/ENOTFOUND/)
    expect(s.order).toEqual([prKey('repo', 5)])
    expect(s.status).toBe('ready')
  })

  test('a loud sync failure records why as well as toasting', async () => {
    mocked.sync.mockRejectedValue(new Error('ADO returned 401'))
    await usePrInboxStore.getState().sync()
    expect(usePrInboxStore.getState().syncError).toMatch(/401/)
    expect(loggedOnce('Could not sync pull requests')).toBe(true)
  })

  test('a successful sync clears an earlier failure', async () => {
    usePrInboxStore.setState({ syncError: 'ADO returned 401' })
    mocked.sync.mockResolvedValue([pr('repo', 7)])
    await usePrInboxStore.getState().sync()
    expect(usePrInboxStore.getState().syncError).toBeNull()
  })

  test('select loads changes and drafts; fetching threads is openDetail\'s job', async () => {
    usePrInboxStore.setState({ prsByKey: { [prKey('repo', 1)]: pr('repo', 1) }, order: [prKey('repo', 1)] })
    mocked.getChanges.mockResolvedValue([change('a.ts')])
    mocked.listDrafts.mockResolvedValue([draft('d1')])
    await usePrInboxStore.getState().select('repo', 1)
    const s = usePrInboxStore.getState()
    expect(s.selectedKey).toBe(prKey('repo', 1))
    expect(s.changes.map((c) => c.path)).toEqual(['a.ts'])
    expect(selectDrafts(s).map((d) => d.id)).toEqual(['d1'])
    expect(s.threads).toEqual([])
    expect(s.threadsLoaded).toBe(false)
    // Selecting on its own stays cheap; the detail decides when the foreign comments are worth
    // fetching.
    expect(mocked.getThreads).not.toHaveBeenCalled()
    expect(mocked.getChanges).toHaveBeenCalledWith('repo', 1)
    expect(s.draftsStatus).toBe('ready')
    expect(s.unfinishedReviews).toEqual({ 'repo:1': 1 })
  })

  test('a draft load failure is explicit and retryable, never an empty successful review', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)],
      unfinishedReviews: { 'repo:1': 2 }
    })
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockRejectedValue(new Error('SQLite busy'))

    await usePrInboxStore.getState().select('repo', 1)

    expect(usePrInboxStore.getState().draftsStatus).toBe('error')
    expect(usePrInboxStore.getState().draftsError).toContain('SQLite busy')
    expect(usePrInboxStore.getState().unfinishedReviews).toEqual({ 'repo:1': 2 })

    mocked.listDrafts.mockResolvedValue([draft('d1'), draft('d2')])
    await usePrInboxStore.getState().loadDrafts()
    expect(usePrInboxStore.getState().draftsStatus).toBe('ready')
    expect(usePrInboxStore.getState().drafts.map((d) => d.id)).toEqual(['d1', 'd2'])
  })

  test('continueReview opens the persisted draft on Files without starting Claude', async () => {
    const key = prKey('repo', 1)
    usePrInboxStore.setState({
      prsByKey: { [key]: pr('repo', 1) },
      order: [key],
      selectedKey: key,
      drafts: [draft('d1', { filePath: 'src/a.ts' })],
      draftsStatus: 'ready',
      unfinishedReviews: { [key]: 1 },
      changes: [change('/src/a.ts')],
      activeTab: 'overview'
    })
    mocked.getFileDiff.mockResolvedValue({
      path: '/src/a.ts',
      original: 'old',
      modified: 'new',
      language: 'typescript',
      binary: false,
      tooLarge: false
    })

    await usePrInboxStore.getState().continueReview()

    expect(usePrInboxStore.getState().activeTab).toBe('files')
    expect(usePrInboxStore.getState().activeFilePath).toBe('/src/a.ts')
    expect(mocked.startReview).not.toHaveBeenCalled()
  })

  test('opening a PR fetches its threads, and switching tabs does not refetch them', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)]
    })
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([thread(10)])

    await usePrInboxStore.getState().openDetail('repo', 1)

    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([10])
    expect(usePrInboxStore.getState().threadsLoaded).toBe(true)
    usePrInboxStore.getState().setTab('overview')
    usePrInboxStore.getState().setTab('files')
    await Promise.resolve()
    expect(mocked.getThreads).toHaveBeenCalledTimes(1)
  })

  test('the conversation is not made to wait for the changed files', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)]
    })
    // The changed files come from git, whose fetch can run for minutes; the threads come from Azure
    // DevOps and depend on none of it, so they must not be queued behind it.
    let releaseChanges = (): void => {}
    mocked.getChanges.mockReturnValue(
      new Promise<PrChangeFile[]>((resolve) => {
        releaseChanges = () => resolve([])
      })
    )
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([thread(10)])

    const opening = usePrInboxStore.getState().openDetail('repo', 1)
    await vi.waitFor(() =>
      expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([10])
    )
    expect(usePrInboxStore.getState().changes).toEqual([])

    releaseChanges()
    await opening
  })

  test('a thread fetch that failed says so and can be retried, rather than reading as no comments', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)]
    })
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockRejectedValue(new Error('TF400813: the token has expired'))

    await usePrInboxStore.getState().openDetail('repo', 1)

    let s = usePrInboxStore.getState()
    expect(s.threads).toEqual([])
    expect(s.threadsLoaded).toBe(false)
    expect(s.threadsError).toMatch(/TF400813/)
    // The threads render on the diff as well as in the conversation, and the diff has nowhere to
    // put the inline state - so the failure is toasted too, for a reader who is on the other tab.
    expect(loggedOnce('Could not load the pull request comments')).toBe(true)

    mocked.getThreads.mockResolvedValue([thread(10)])
    await usePrInboxStore.getState().loadThreads()

    s = usePrInboxStore.getState()
    expect(s.threads.map((t) => t.threadId)).toEqual([10])
    expect(s.threadsLoaded).toBe(true)
    expect(s.threadsError).toBeNull()
    // A retry that worked says nothing further.
    expect(loggedOnce('Could not load the pull request comments')).toBe(true)
  })

  test('reopening the same PR refetches its threads rather than trusting the last visit', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)]
    })
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([thread(10)])

    await usePrInboxStore.getState().openDetail('repo', 1)
    usePrInboxStore.getState().goBack()
    await usePrInboxStore.getState().openDetail('repo', 1)

    expect(mocked.getThreads).toHaveBeenCalledTimes(2)
  })

  test('an older thread fetch that lands last does not overwrite the newer one', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)],
      selectedKey: prKey('repo', 1)
    })
    // Leaving and returning to the same PR leaves two fetches in flight under one key, so the key
    // alone cannot tell them apart - only which was issued later can.
    const resolvers: Array<(threads: PrThread[]) => void> = []
    mocked.getThreads.mockImplementation(
      () => new Promise<PrThread[]>((resolve) => resolvers.push(resolve))
    )

    const first = usePrInboxStore.getState().loadThreads()
    usePrInboxStore.setState({ threadsLoaded: false })
    const second = usePrInboxStore.getState().loadThreads()
    expect(resolvers).toHaveLength(2)

    resolvers[1]([thread(20)])
    resolvers[0]([thread(10)])
    await Promise.all([first, second])

    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([20])
  })

  test('select records a changesError inline when the diff cannot load (e.g. no local clone)', async () => {
    usePrInboxStore.setState({ prsByKey: { [prKey('repo', 1)]: pr('repo', 1) }, order: [prKey('repo', 1)] })
    mocked.getChanges.mockRejectedValue(new Error('No local clone found for repository "repo".'))
    mocked.listDrafts.mockResolvedValue([])
    await usePrInboxStore.getState().select('repo', 1)
    const s = usePrInboxStore.getState()
    expect(s.changes).toEqual([])
    expect(s.changesError).toMatch(/No local clone/)
  })

  test('setCommentDraft persists text and clears the entry when set empty', () => {
    usePrInboxStore.getState().setCommentDraft('reply:10', 'half-typed')
    expect(usePrInboxStore.getState().commentDrafts).toEqual({ 'reply:10': 'half-typed' })
    usePrInboxStore.getState().setCommentDraft('reply:10', '')
    expect(usePrInboxStore.getState().commentDrafts).toEqual({})
  })

  test('select discards any in-progress comment drafts from the previous PR', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)],
      commentDrafts: { 'reply:10': 'stale' }
    })
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([])
    await usePrInboxStore.getState().select('repo', 1)
    expect(usePrInboxStore.getState().commentDrafts).toEqual({})
  })

  test('castVote replaces the cached PR with the returned row once ADO accepted the vote', async () => {
    const key = prKey('repo', 1)
    usePrInboxStore.setState({
      prsByKey: { [key]: pr('repo', 1, { myVote: 'noVote', myReviewerId: 'me' }) },
      order: [key],
      selectedKey: key
    })
    mocked.castVote.mockResolvedValue(
      pr('repo', 1, { myVote: 'approved', myReviewerId: 'me' })
    )
    await usePrInboxStore.getState().castVote('approved')
    expect(mocked.castVote).toHaveBeenCalledWith('repo', 1, 'approved')
    expect(usePrInboxStore.getState().prsByKey[key].myVote).toBe('approved')
  })

  test('a failed castVote reports the error and leaves the PR state unchanged', async () => {
    const key = prKey('repo', 1)
    usePrInboxStore.setState({
      prsByKey: { [key]: pr('repo', 1, { myVote: 'noVote', myReviewerId: 'me' }) },
      order: [key],
      selectedKey: key
    })
    mocked.castVote.mockRejectedValue(new Error('ADO down'))
    await usePrInboxStore.getState().castVote('approved')
    expect(usePrInboxStore.getState().prsByKey[key].myVote).toBe('noVote')
    expect(loggedOnce('Could not cast vote')).toBe(true)
  })

  test('castVote without a selected PR is a no-op', async () => {
    await usePrInboxStore.getState().castVote('approved')
    expect(mocked.castVote).not.toHaveBeenCalled()
  })

  test('publishDraft removes completed work and clears the unfinished indicator', async () => {
    usePrInboxStore.setState({
      selectedKey: 'repo:1',
      drafts: [draft('d1', { status: 'pending' })],
      unfinishedReviews: { 'repo:1': 1 }
    })
    mocked.publishDraft.mockResolvedValue(draft('d1', { status: 'published', publishedThreadId: 42 }))
    await usePrInboxStore.getState().publishDraft('d1')
    expect(mocked.publishDraft).toHaveBeenCalledWith('d1')
    expect(usePrInboxStore.getState().drafts).toEqual([])
    expect(usePrInboxStore.getState().unfinishedReviews).toEqual({})
  })

  test('a pushed draft updates the board count even while no PR detail is selected', () => {
    let push: ((value: DraftComment) => void) | undefined
    mocked.onDraftAdded.mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    mocked.onReviewData.mockReturnValue(() => {})
    mocked.onReviewExit.mockReturnValue(() => {})
    const off = usePrInboxStore.getState().subscribe()

    push?.(draft('d1'))

    expect(usePrInboxStore.getState().unfinishedReviews).toEqual({ 'repo:1': 1 })
    off()
  })
})

describe('syncIfStale', () => {
  /**
   * The five minutes the guard promises, written out here rather than imported, so the two
   * boundary cases below actually pin that number instead of following it wherever it moves.
   */
  const STALE_AFTER_MS = 5 * 60 * 1000

  const syncedAgo = (ms: number): void => usePrInboxStore.setState({ syncedAt: Date.now() - ms })

  beforeEach(() => {
    usePrInboxStore.getState().setAdoConnected(true)
    mocked.sync.mockResolvedValue([])
  })

  test('a board that has never synced is refreshed', async () => {
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).toHaveBeenCalledOnce()
  })

  test('a board refreshed a moment ago is left alone', async () => {
    syncedAgo(0)
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).not.toHaveBeenCalled()
  })

  test('a board refreshed just inside five minutes is left alone', async () => {
    syncedAgo(STALE_AFTER_MS - 1000)
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).not.toHaveBeenCalled()
  })

  test('a board refreshed just outside five minutes is refreshed', async () => {
    syncedAgo(STALE_AFTER_MS + 1000)
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).toHaveBeenCalledOnce()
  })

  test('a stale board is not refreshed without an Azure DevOps connection', async () => {
    usePrInboxStore.getState().setAdoConnected(false)
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).not.toHaveBeenCalled()
  })

  test('a stale board is not refreshed while the connection is still unknown', async () => {
    // Nothing has published a connection yet, which is the state at boot before settings land. An
    // unknown connection must read as no connection, or the guard reaches for a network that may
    // not be there.
    usePrInboxStore.setState({ adoConnected: false })
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).not.toHaveBeenCalled()
  })

  test('a sync already in flight is never joined by a second one', async () => {
    usePrInboxStore.setState({ syncing: true })
    await usePrInboxStore.getState().syncIfStale()
    expect(mocked.sync).not.toHaveBeenCalled()
  })
})

describe('board navigation', () => {
  test('openDetail loads the PR and lands on Overview; goBack returns to board', async () => {
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([])
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'] })
    await usePrInboxStore.getState().openDetail('r', 1)
    expect(usePrInboxStore.getState().view).toBe('detail')
    expect(usePrInboxStore.getState().activeTab).toBe('overview')
    expect(usePrInboxStore.getState().selectedKey).toBe('r:1')
    usePrInboxStore.getState().goBack()
    expect(usePrInboxStore.getState().view).toBe('board')
    expect(usePrInboxStore.getState().selectedKey).toBeNull()
  })
})

describe('review session', () => {
  const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({
    id: 'rs-1',
    prId: 1,
    repositoryId: 'r',
    repoDir: '/clone',
    worktreePath: '/wt',
    status: 'running',
    createdAt: 0,
    ...over
  })

  beforeEach(() => {
    resetReviewOutput()
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1), 'r:2': pr('r', 2) },
      order: ['r:1', 'r:2'],
      selectedKey: 'r:1'
    })
    mocked.startReview.mockResolvedValue(session())
    mocked.endReview.mockResolvedValue(undefined)
  })

  test('startReview binds the PR to its session and opens the terminal view', async () => {
    await usePrInboxStore.getState().startReview()
    const s = usePrInboxStore.getState()
    expect(s.liveReviews).toEqual({ 'r:1': 'rs-1' })
    expect(s.reviewViews['rs-1']).toBe('terminal')
    expect(selectSelectedReviewSessionId(s)).toBe('rs-1')
  })

  test('a second PR is reviewed without ending the first', async () => {
    await usePrInboxStore.getState().startReview()

    usePrInboxStore.setState({ selectedKey: 'r:2' })
    mocked.startReview.mockResolvedValue(session({ id: 'rs-2', prId: 2 }))
    await usePrInboxStore.getState().startReview()

    const s = usePrInboxStore.getState()
    expect(s.liveReviews).toEqual({ 'r:1': 'rs-1', 'r:2': 'rs-2' })
    expect(mocked.endReview).not.toHaveBeenCalled()
  })

  test('a running session survives going back to the board, output included', async () => {
    await usePrInboxStore.getState().startReview()
    appendReviewOutput('rs-1', 'partial output')

    usePrInboxStore.getState().goBack()

    const s = usePrInboxStore.getState()
    expect(s.view).toBe('board')
    expect(s.liveReviews).toEqual({ 'r:1': 'rs-1' })
    expect(readReviewOutput('rs-1').text).toBe('partial output')
  })

  test('setReviewView toggles one session without touching another', async () => {
    await usePrInboxStore.getState().startReview()
    usePrInboxStore.setState({ selectedKey: 'r:2' })
    mocked.startReview.mockResolvedValue(session({ id: 'rs-2', prId: 2 }))
    await usePrInboxStore.getState().startReview()

    usePrInboxStore.getState().setReviewView('rs-2', 'changes')

    expect(usePrInboxStore.getState().reviewViews).toEqual({ 'rs-1': 'terminal', 'rs-2': 'changes' })
  })

  test('endReview releases only its own PR', async () => {
    await usePrInboxStore.getState().startReview()
    usePrInboxStore.setState({ selectedKey: 'r:2' })
    mocked.startReview.mockResolvedValue(session({ id: 'rs-2', prId: 2 }))
    await usePrInboxStore.getState().startReview()

    await usePrInboxStore.getState().endReview('rs-1')

    expect(mocked.endReview).toHaveBeenCalledWith('rs-1')
    expect(usePrInboxStore.getState().liveReviews).toEqual({ 'r:2': 'rs-2' })
    expect(usePrInboxStore.getState().reviewViews).toEqual({ 'rs-2': 'terminal' })
  })

  test('a failed end still releases the PR instead of leaving it looking busy', async () => {
    await usePrInboxStore.getState().startReview()
    mocked.endReview.mockRejectedValue(new Error('pty gone'))

    await usePrInboxStore.getState().endReview('rs-1')

    expect(usePrInboxStore.getState().liveReviews).toEqual({})
  })

  test('starting a PR that is already under review rebinds to the running session', async () => {
    await usePrInboxStore.getState().startReview()
    appendReviewOutput('rs-1', 'earlier output')

    // Main answers with the session it already has rather than opening a second one.
    await usePrInboxStore.getState().startReview()

    expect(usePrInboxStore.getState().liveReviews).toEqual({ 'r:1': 'rs-1' })
    expect(readReviewOutput('rs-1').text).toBe('earlier output')
  })

  test('input and resize are addressed to the session they belong to', async () => {
    usePrInboxStore.getState().reviewInput('rs-7', 'typed\r')
    usePrInboxStore.getState().reviewResize('rs-7', 120, 40)

    expect(mocked.reviewInput).toHaveBeenCalledWith('rs-7', 'typed\r')
    expect(mocked.reviewResize).toHaveBeenCalledWith('rs-7', 120, 40)
  })
})

describe('review broadcasts', () => {
  beforeEach(() => {
    resetReviewOutput()
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1), 'r:2': pr('r', 2) },
      order: ['r:1', 'r:2'],
      liveReviews: { 'r:1': 'rs-1', 'r:2': 'rs-2' },
      reviewViews: { 'rs-1': 'terminal', 'rs-2': 'changes' }
    })
  })

  test('output is buffered per session and never written to the store', async () => {
    const off = usePrInboxStore.getState().subscribe()
    const before = usePrInboxStore.getState()

    emitReviewData({ sessionId: 'rs-1', data: 'first' })
    emitReviewData({ sessionId: 'rs-2', data: 'second' })

    expect(readReviewOutput('rs-1').text).toBe('first')
    expect(readReviewOutput('rs-2').text).toBe('second')
    // A PTY chunk must not re-render the board: the store is untouched.
    expect(usePrInboxStore.getState()).toBe(before)
    off()
  })

  test('one session exiting leaves every other review running', async () => {
    const off = usePrInboxStore.getState().subscribe()
    appendReviewOutput('rs-1', 'output to drop')

    emitReviewExit({ sessionId: 'rs-1', exitCode: 0 })

    const s = usePrInboxStore.getState()
    expect(s.liveReviews).toEqual({ 'r:2': 'rs-2' })
    expect(s.reviewViews).toEqual({ 'rs-2': 'changes' })
    // The finished session's buffer is released rather than kept for the app's lifetime.
    expect(readReviewOutput('rs-1').text).toBe('')
    off()
  })
})

describe('groupBoardColumns', () => {
  test('splits PRs by boardColumn, most recently active first', () => {
    usePrInboxStore.setState({
      prsByKey: {
        'r:1': pr('r', 1, { role: 'reviewer', myVote: null, lastActivityAt: 10 }),
        'r:2': pr('r', 2, { role: 'reviewer', myVote: 'approved', lastActivityAt: 20 }),
        'r:3': pr('r', 3, {
          role: 'author',
          lastActivityAt: 30,
          reviewers: [{ id: 'x', displayName: 'X', vote: 'approved', isRequired: false }]
        }),
        'r:4': pr('r', 4, { role: 'reviewer', myVote: null, lastActivityAt: 40 })
      },
      order: ['r:1', 'r:2', 'r:3', 'r:4']
    })
    const cols = groupBoardColumns(selectPrList(usePrInboxStore.getState()))
    expect(cols.action.map((p) => p.prId)).toEqual([4, 1])
    expect(cols.waiting.map((p) => p.prId)).toEqual([2])
    expect(cols.approved.map((p) => p.prId)).toEqual([3])
  })

  test('a long-lived PR touched just now outranks a brand-new quiet one', () => {
    usePrInboxStore.setState({
      prsByKey: {
        'r:1': pr('r', 1, { role: 'reviewer', myVote: null, createdAt: 100, lastActivityAt: 900 }),
        'r:2': pr('r', 2, { role: 'reviewer', myVote: null, createdAt: 500, lastActivityAt: 500 })
      },
      order: ['r:1', 'r:2']
    })
    const cols = groupBoardColumns(selectPrList(usePrInboxStore.getState()))
    expect(cols.action.map((p) => p.prId)).toEqual([1, 2])
  })
})

describe('thread actions', () => {
  beforeEach(() => {
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1' })
  })

  test('replyToThread refreshes threads from the response and signals success', async () => {
    const fresh = [thread(42)]
    mocked.replyToThread.mockResolvedValue(fresh)
    const ok = await usePrInboxStore.getState().replyToThread(42, 'ok')
    expect(ok).toBe(true)
    expect(mocked.replyToThread).toHaveBeenCalledWith('r', 1, 42, 'ok')
    expect(usePrInboxStore.getState().threads).toEqual(fresh)
  })

  test('replyToThread signals failure without clobbering threads', async () => {
    usePrInboxStore.setState({ threads: [thread(1)] })
    mocked.replyToThread.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().replyToThread(42, 'ok')
    expect(ok).toBe(false)
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([1])
  })

  test('setThreadStatus refreshes threads and signals success', async () => {
    mocked.setThreadStatus.mockResolvedValue([thread(42, { status: 'fixed' })])
    const ok = await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(ok).toBe(true)
    expect(mocked.setThreadStatus).toHaveBeenCalledWith('r', 1, 42, 'fixed')
    expect(usePrInboxStore.getState().threads[0].status).toBe('fixed')
  })

  test('setThreadStatus signals failure', async () => {
    mocked.setThreadStatus.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(ok).toBe(false)
  })

  test('addComment publishes, refreshes threads and signals success', async () => {
    mocked.addComment.mockResolvedValue([thread(43)])
    const ok = await usePrInboxStore.getState().addComment('/a.cs', 3, 'new comment')
    expect(ok).toBe(true)
    expect(mocked.addComment).toHaveBeenCalledWith({
      repositoryId: 'r',
      prId: 1,
      filePath: '/a.cs',
      line: 3,
      body: 'new comment'
    })
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toContain(43)
  })

  test('addComment signals failure so the composer can keep the typed text', async () => {
    mocked.addComment.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().addComment('/a.cs', 3, 'new comment')
    expect(ok).toBe(false)
  })
})

describe('header links to Azure DevOps', () => {
  const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() }
  const WEB_URL = 'https://devops.example.com/tfs/DefaultCollection/proj/_git/repo/pullrequest/1'

  beforeEach(() => {
    clipboard.writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1, { projectId: 'proj', repositoryName: 'repo' }) },
      order: ['r:1'],
      selectedKey: 'r:1',
      adoOrgUrl: 'https://devops.example.com/tfs/DefaultCollection'
    })
  })

  test('the link handed out is the browsable page, not the REST resource the payload carried', () => {
    mocked.openExternal.mockResolvedValue(undefined)
    // The PR's own `url` is the "used internally" REST endpoint; opening it would show a human JSON.
    expect(selectSelectedPr(usePrInboxStore.getState())!.url).toBe('https://ado/pr')
    usePrInboxStore.getState().openInBrowser()
    expect(mocked.openExternal).toHaveBeenCalledWith(WEB_URL)
  })

  test('a browser that refuses to open reports it instead of vanishing', async () => {
    mocked.openExternal.mockRejectedValue(new Error('blocked'))
    usePrInboxStore.getState().openInBrowser()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loggedOnce('Could not open the pull request')).toBe(true)
  })

  test('copying puts the browsable page on the clipboard', async () => {
    await usePrInboxStore.getState().copyLink()
    expect(clipboard.writeText).toHaveBeenCalledWith(WEB_URL)
  })

  test('a changed organisation URL is reflected without the board being re-synced', () => {
    mocked.openExternal.mockResolvedValue(undefined)
    usePrInboxStore.setState({ adoOrgUrl: 'https://elsewhere.example.com' })
    usePrInboxStore.getState().openInBrowser()
    expect(mocked.openExternal).toHaveBeenCalledWith(
      'https://elsewhere.example.com/proj/_git/repo/pullrequest/1'
    )
  })

  test('no configured organisation means no link to hand out at all', async () => {
    usePrInboxStore.setState({ adoOrgUrl: '' })
    usePrInboxStore.getState().openInBrowser()
    await usePrInboxStore.getState().copyLink()
    expect(mocked.openExternal).not.toHaveBeenCalled()
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
})

describe('revealThread', () => {
  test('switches to files tab, opens the file, remembers the line', () => {
    mocked.getFileDiff.mockResolvedValue({
      path: '/a.cs',
      original: '',
      modified: '',
      language: 'plaintext',
      binary: false,
      tooLarge: false
    })
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1) },
      order: ['r:1'],
      selectedKey: 'r:1',
      activeTab: 'overview'
    })
    usePrInboxStore.getState().revealThread('/a.cs', 12)
    expect(usePrInboxStore.getState().activeTab).toBe('files')
    expect(usePrInboxStore.getState().pendingReveal).toEqual({ path: '/a.cs', line: 12 })
    expect(usePrInboxStore.getState().activeFilePath).toBe('/a.cs')
    usePrInboxStore.getState().clearReveal()
    expect(usePrInboxStore.getState().pendingReveal).toBeNull()
  })
})

describe('splitThreadsByResolution', () => {
  test('answers the unresolved threads and the resolved ones, in that order', () => {
    const split = splitThreadsByResolution([
      thread(1, { status: 'fixed' }),
      thread(2, { status: 'active' }),
      thread(3, { status: 'closed' }),
      thread(4, { status: 'pending' })
    ])
    expect(split.unresolved.map((t) => t.threadId)).toEqual([2, 4])
    expect(split.resolved.map((t) => t.threadId)).toEqual([1, 3])
  })

  test('the housekeeping Azure DevOps writes on a PR appears in neither half', () => {
    const split = splitThreadsByResolution([
      thread(1, { status: 'active', isSystem: true }),
      thread(2, { status: 'fixed', isSystem: true })
    ])
    expect(split.unresolved).toEqual([])
    expect(split.resolved).toEqual([])
  })

  test('the relative order of the threads within each half is left alone', () => {
    const split = splitThreadsByResolution([thread(9), thread(3), thread(7)])
    expect(split.unresolved.map((t) => t.threadId)).toEqual([9, 3, 7])
  })
})
