import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftComment, PrChangeFile, PrThread, PullRequest } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import { prKey, selectDrafts, selectPrList, usePrInboxStore } from './store'

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
  reviewers: [],
  newChangesSinceMyReview: false,
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
const thread = (threadId: number): PrThread => ({
  threadId,
  filePath: 'a.ts',
  line: 1,
  status: 'active',
  comments: []
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
      review: { status: 'idle' }
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

  test('addManualDraft appends the created draft', async () => {
    mocked.addManualDraft.mockResolvedValue(draft('d2'))
    await usePrInboxStore.getState().addManualDraft({
      prId: 1,
      repositoryId: 'repo',
      filePath: 'a.ts',
      line: 3,
      side: 'right',
      body: 'body'
    })
    expect(usePrInboxStore.getState().drafts.map((d) => d.id)).toEqual(['d2'])
    expect(mocked.addManualDraft).toHaveBeenCalled()
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
