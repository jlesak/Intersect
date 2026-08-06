import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftComment, PrChangeFile, PrThread, PullRequest } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import {
  groupBoardColumns,
  prKey,
  selectDrafts,
  selectFilteredThreads,
  selectPrList,
  usePrInboxStore
} from './store'

const pr = (repositoryId: string, prId: number, over: Partial<PullRequest> = {}): PullRequest => ({
  prId,
  repositoryId,
  repositoryName: repositoryId,
  projectId: 'proj',
  title: `PR ${prId}`,
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
  publishedThreadId: null,
  createdAt: 0,
  ...over
})

const change = (path: string): PrChangeFile => ({ path, changeType: 'edit', originalPath: null })
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
      drafts: [],
      commentDrafts: {},
      review: { status: 'idle' },
      reviewView: 'terminal',
      reviewPrKey: null,
      reviewOutput: '',
      view: 'board',
      activeTab: 'files',
      threadFilter: 'active',
      pendingReveal: null
    },
    false
  )
  vi.clearAllMocks()
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

  test('sync populates the list and clears the syncing flag', async () => {
    mocked.sync.mockResolvedValue([pr('repo', 7)])
    await usePrInboxStore.getState().sync()
    const s = usePrInboxStore.getState()
    expect(s.syncing).toBe(false)
    expect(s.order).toEqual([prKey('repo', 7)])
    expect(s.prsByKey[prKey('repo', 7)].prId).toBe(7)
  })

  test('a quiet sync failure warns without toasting and clears the syncing flag', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocked.sync.mockRejectedValue(new Error('ADO not configured'))
    await usePrInboxStore.getState().sync({ quiet: true })
    expect(usePrInboxStore.getState().syncing).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('a quiet sync failure records why, and keeps the cached board', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    warn.mockRestore()
  })

  test('a loud sync failure records why as well as toasting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocked.sync.mockRejectedValue(new Error('ADO returned 401'))
    await usePrInboxStore.getState().sync()
    expect(usePrInboxStore.getState().syncError).toMatch(/401/)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not sync pull requests'))
    error.mockRestore()
  })

  test('a successful sync clears an earlier failure', async () => {
    usePrInboxStore.setState({ syncError: 'ADO returned 401' })
    mocked.sync.mockResolvedValue([pr('repo', 7)])
    await usePrInboxStore.getState().sync()
    expect(usePrInboxStore.getState().syncError).toBeNull()
  })

  test('select loads changes and drafts but defers threads (lazy)', async () => {
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
    // Opening the PR must not pay for the foreign-comment fetch.
    expect(mocked.getThreads).not.toHaveBeenCalled()
    expect(mocked.getChanges).toHaveBeenCalledWith('repo', 1)
  })

  test('threads load lazily on first Overview open, and are not refetched', async () => {
    usePrInboxStore.setState({
      prsByKey: { [prKey('repo', 1)]: pr('repo', 1) },
      order: [prKey('repo', 1)],
      selectedKey: prKey('repo', 1)
    })
    mocked.getThreads.mockResolvedValue([thread(10)])
    usePrInboxStore.getState().setTab('overview')
    await Promise.resolve()
    await Promise.resolve()
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([10])
    expect(usePrInboxStore.getState().threadsLoaded).toBe(true)
    // Switch away and back: no second fetch.
    usePrInboxStore.getState().setTab('files')
    usePrInboxStore.getState().setTab('overview')
    await Promise.resolve()
    expect(mocked.getThreads).toHaveBeenCalledTimes(1)
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const key = prKey('repo', 1)
    usePrInboxStore.setState({
      prsByKey: { [key]: pr('repo', 1, { myVote: 'noVote', myReviewerId: 'me' }) },
      order: [key],
      selectedKey: key
    })
    mocked.castVote.mockRejectedValue(new Error('ADO down'))
    await usePrInboxStore.getState().castVote('approved')
    expect(usePrInboxStore.getState().prsByKey[key].myVote).toBe('noVote')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not cast vote'))
    error.mockRestore()
  })

  test('castVote without a selected PR is a no-op', async () => {
    await usePrInboxStore.getState().castVote('approved')
    expect(mocked.castVote).not.toHaveBeenCalled()
  })

  test('publishDraft calls the IPC and replaces the draft with the published row', async () => {
    usePrInboxStore.setState({ drafts: [draft('d1', { status: 'pending' })] })
    mocked.publishDraft.mockResolvedValue(draft('d1', { status: 'published', publishedThreadId: 42 }))
    await usePrInboxStore.getState().publishDraft('d1')
    const d = usePrInboxStore.getState().drafts.find((x) => x.id === 'd1')
    expect(mocked.publishDraft).toHaveBeenCalledWith('d1')
    expect(d?.status).toBe('published')
    expect(d?.publishedThreadId).toBe(42)
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
  test('openDetail loads the PR and switches view; goBack returns to board', async () => {
    mocked.getChanges.mockResolvedValue([])
    mocked.listDrafts.mockResolvedValue([])
    mocked.getThreads.mockResolvedValue([])
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'] })
    await usePrInboxStore.getState().openDetail('r', 1)
    expect(usePrInboxStore.getState().view).toBe('detail')
    expect(usePrInboxStore.getState().activeTab).toBe('files')
    expect(usePrInboxStore.getState().selectedKey).toBe('r:1')
    usePrInboxStore.getState().goBack()
    expect(usePrInboxStore.getState().view).toBe('board')
    expect(usePrInboxStore.getState().selectedKey).toBeNull()
  })
})

describe('review session', () => {
  beforeEach(() => {
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1) },
      order: ['r:1'],
      selectedKey: 'r:1'
    })
    mocked.startReview.mockResolvedValue({
      id: 'rs-1',
      prId: 1,
      repositoryId: 'r',
      repoDir: '/clone',
      worktreePath: '/wt',
      status: 'running',
      createdAt: 0
    })
    mocked.endReview.mockResolvedValue(undefined)
  })

  test('startReview marks the PR under review and opens the terminal view', async () => {
    await usePrInboxStore.getState().startReview()
    const s = usePrInboxStore.getState()
    expect(s.review.status).toBe('running')
    expect(s.reviewPrKey).toBe('r:1')
    expect(s.reviewView).toBe('terminal')
  })

  test('a running session survives going back to the board', async () => {
    await usePrInboxStore.getState().startReview()
    usePrInboxStore.setState({ reviewOutput: 'partial output' })
    usePrInboxStore.getState().goBack()
    const s = usePrInboxStore.getState()
    expect(s.view).toBe('board')
    expect(s.review.status).toBe('running')
    expect(s.reviewPrKey).toBe('r:1')
    expect(s.reviewOutput).toBe('partial output')
  })

  test('setReviewView toggles between terminal and changes', async () => {
    await usePrInboxStore.getState().startReview()
    usePrInboxStore.getState().setReviewView('changes')
    expect(usePrInboxStore.getState().reviewView).toBe('changes')
    usePrInboxStore.getState().setReviewView('terminal')
    expect(usePrInboxStore.getState().reviewView).toBe('terminal')
  })

  test('endReview clears the session, its PR marker and the buffer', async () => {
    await usePrInboxStore.getState().startReview()
    usePrInboxStore.setState({ reviewOutput: 'x' })
    await usePrInboxStore.getState().endReview()
    const s = usePrInboxStore.getState()
    expect(s.review.status).toBe('idle')
    expect(s.reviewPrKey).toBeNull()
    expect(s.reviewOutput).toBe('')
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    usePrInboxStore.setState({ threads: [thread(1)] })
    mocked.replyToThread.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().replyToThread(42, 'ok')
    expect(ok).toBe(false)
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toEqual([1])
    error.mockRestore()
  })

  test('setThreadStatus refreshes threads and signals success', async () => {
    mocked.setThreadStatus.mockResolvedValue([thread(42, { status: 'fixed' })])
    const ok = await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(ok).toBe(true)
    expect(mocked.setThreadStatus).toHaveBeenCalledWith('r', 1, 42, 'fixed')
    expect(usePrInboxStore.getState().threads[0].status).toBe('fixed')
  })

  test('setThreadStatus signals failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocked.setThreadStatus.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(ok).toBe(false)
    error.mockRestore()
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocked.addComment.mockRejectedValue(new Error('boom'))
    const ok = await usePrInboxStore.getState().addComment('/a.cs', 3, 'new comment')
    expect(ok).toBe(false)
    error.mockRestore()
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

describe('selectFilteredThreads', () => {
  const seed = (): void =>
    usePrInboxStore.setState({
      threads: [
        thread(1, { status: 'active' }),
        thread(2, { status: 'fixed' }),
        thread(3, { status: 'active', isSystem: true })
      ]
    })

  test('active filter hides resolved and system threads', () => {
    seed()
    usePrInboxStore.setState({ threadFilter: 'active' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([1])
  })

  test('all shows everything except system; resolved shows only resolved', () => {
    seed()
    usePrInboxStore.setState({ threadFilter: 'all' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([1, 2])
    usePrInboxStore.setState({ threadFilter: 'resolved' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([2])
  })
})
