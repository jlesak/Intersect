import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftComment, PrChangeFile, PrThread, PullRequest } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import {
  prKey,
  selectBoardColumns,
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

  test('select loads changes, drafts and threads for the PR', async () => {
    usePrInboxStore.setState({ prsByKey: { [prKey('repo', 1)]: pr('repo', 1) }, order: [prKey('repo', 1)] })
    mocked.getChanges.mockResolvedValue([change('a.ts')])
    mocked.listDrafts.mockResolvedValue([draft('d1')])
    mocked.getThreads.mockResolvedValue([thread(10)])
    await usePrInboxStore.getState().select('repo', 1)
    const s = usePrInboxStore.getState()
    expect(s.selectedKey).toBe(prKey('repo', 1))
    expect(s.changes.map((c) => c.path)).toEqual(['a.ts'])
    expect(selectDrafts(s).map((d) => d.id)).toEqual(['d1'])
    expect(s.threads.map((t) => t.threadId)).toEqual([10])
    expect(mocked.getChanges).toHaveBeenCalledWith('repo', 1)
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

describe('selectBoardColumns', () => {
  test('splits PRs by boardColumn, newest first', () => {
    usePrInboxStore.setState({
      prsByKey: {
        'r:1': pr('r', 1, { role: 'reviewer', myVote: null, createdAt: 10 }),
        'r:2': pr('r', 2, { role: 'reviewer', myVote: 'approved', createdAt: 20 }),
        'r:3': pr('r', 3, {
          role: 'author',
          createdAt: 30,
          reviewers: [{ id: 'x', displayName: 'X', vote: 'approved', isRequired: false }]
        }),
        'r:4': pr('r', 4, { role: 'reviewer', myVote: null, createdAt: 40 })
      },
      order: ['r:1', 'r:2', 'r:3', 'r:4']
    })
    const cols = selectBoardColumns(usePrInboxStore.getState())
    expect(cols.action.map((p) => p.prId)).toEqual([4, 1])
    expect(cols.waiting.map((p) => p.prId)).toEqual([2])
    expect(cols.approved.map((p) => p.prId)).toEqual([3])
  })
})

describe('thread actions', () => {
  beforeEach(() => {
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1' })
  })

  test('replyToThread refreshes threads from the response', async () => {
    const fresh = [thread(42)]
    mocked.replyToThread.mockResolvedValue(fresh)
    await usePrInboxStore.getState().replyToThread(42, 'ok')
    expect(mocked.replyToThread).toHaveBeenCalledWith('r', 1, 42, 'ok')
    expect(usePrInboxStore.getState().threads).toEqual(fresh)
  })

  test('setThreadStatus refreshes threads', async () => {
    mocked.setThreadStatus.mockResolvedValue([thread(42, { status: 'fixed' })])
    await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(mocked.setThreadStatus).toHaveBeenCalledWith('r', 1, 42, 'fixed')
    expect(usePrInboxStore.getState().threads[0].status).toBe('fixed')
  })

  test('addComment publishes and refreshes threads', async () => {
    mocked.addComment.mockResolvedValue([thread(43)])
    await usePrInboxStore.getState().addComment('/a.cs', 3, 'new comment')
    expect(mocked.addComment).toHaveBeenCalledWith({
      repositoryId: 'r',
      prId: 1,
      filePath: '/a.cs',
      line: 3,
      body: 'new comment'
    })
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toContain(43)
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
