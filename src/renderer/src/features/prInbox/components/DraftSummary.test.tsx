import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftComment, DraftSnippet, PullRequest } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { usePrInboxStore } from '../store'
import { DraftSummary, groupDraftsByFile } from './DraftSummary'

const mocked = vi.mocked(api)

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 1,
  repositoryId: 'repo-1',
  repositoryName: 'intersect-app',
  projectId: 'SPOT',
  title: 'Add rate limiting',
  description: '',
  authorId: 'u1',
  authorName: 'Jan Lesak',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/feature/rate-limit',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'head-sha',
  targetCommitId: 'b',
  url: 'https://devops/pr/1',
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
  repositoryId: 'repo-1',
  filePath: '/src/app/sync/rateLimiter.ts',
  line: 12,
  side: 'right',
  body: `Finding ${id}`,
  status: 'pending',
  source: 'claude',
  reviewSessionId: 'review-1',
  sourceCommitId: 'head-sha',
  publishedThreadId: null,
  createdAt: 1,
  ...over
})

const snippet = (over: Partial<DraftSnippet> = {}): DraftSnippet => ({
  startLine: 11,
  anchorLine: 12,
  lines: ['const limit = 25', 'const burst = 5', 'return limit'],
  side: 'right',
  ...over
})

const seed = async (state: Partial<Parameters<typeof usePrInboxStore.setState>[0]> = {}): Promise<void> => {
  usePrInboxStore.setState({
    prsByKey: { 'repo-1:1': pr() },
    order: ['repo-1:1'],
    selectedKey: 'repo-1:1',
    view: 'detail',
    activeTab: 'drafts',
    liveReviews: { 'repo-1:1': 'sess-1' },
    reviewViews: { 'sess-1': 'drafts' },
    pendingReveal: null,
    activeFilePath: null,
    drafts: [],
    draftsStatus: 'ready',
    draftSnippets: {},
    draftSnippetsStatus: 'idle',
    draftSnippetsError: null,
    ...state
  })
  await act(async () => {
    render(<DraftSummary />)
  })
}

const el = (testId: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
const all = (testId: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
]

describe('groupDraftsByFile', () => {
  test('groups by file, keeps the files in first-comment order, and sorts by line', () => {
    const groups = groupDraftsByFile([
      draft('a', { filePath: '/src/b.ts', line: 30 }),
      draft('b', { filePath: '/src/a.ts', line: 9 }),
      draft('c', { filePath: '/src/b.ts', line: 4 })
    ])

    expect(groups.map((g) => g.filePath)).toEqual(['/src/b.ts', '/src/a.ts'])
    expect(groups[0].drafts.map((d) => d.id)).toEqual(['c', 'a'])
  })

  test('a legacy repo-relative path lands in the same group as its canonical twin', () => {
    const groups = groupDraftsByFile([
      draft('a', { filePath: '/src/a.ts', line: 2 }),
      draft('b', { filePath: 'src/a.ts', line: 1 })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].drafts.map((d) => d.id)).toEqual(['b', 'a'])
  })
})

describe('DraftSummary', () => {
  beforeEach(() => {
    mocked.getDraftSnippets.mockReset()
    mocked.getFileDiff.mockResolvedValue({
      path: '/src/app/sync/rateLimiter.ts',
      original: '',
      modified: '',
      language: 'typescript',
      binary: false,
      tooLarge: false
    })
  })

  afterEach(() => {
    usePrInboxStore.setState({ selectedKey: null, view: 'board', drafts: [], draftSnippets: {} })
  })

  test('says there is nothing to approve rather than showing an empty list', async () => {
    await seed()

    expect(el('pr-draft-summary').textContent).toContain('Nothing to approve')
    expect(all('pr-draft')).toHaveLength(0)
    expect(mocked.getDraftSnippets).not.toHaveBeenCalled()
  })

  test('shows every proposed comment with the code it is about, grouped per file', async () => {
    mocked.getDraftSnippets.mockResolvedValue({
      d1: snippet(),
      d2: snippet({ startLine: 40, anchorLine: 41, lines: ['await queue.drain()'] })
    })
    await seed({
      drafts: [draft('d1'), draft('d2', { filePath: '/src/app/sync/queue.ts', line: 41 })]
    })

    expect(all('pr-draft-group')).toHaveLength(2)
    expect(all('pr-draft')).toHaveLength(2)
    expect(el('pr-draft-summary').textContent).toContain('2 comments in 2 files')
    const snippets = all('pr-draft-snippet')
    expect(snippets).toHaveLength(2)
    expect(snippets[0].textContent).toContain('const burst = 5')
    // The anchored line is the one marked, and it is numbered as the file numbers it.
    const anchored = snippets[0].querySelector('.ix-draft-snippet__line--anchor')
    expect(anchored?.textContent).toContain('12')
    expect(anchored?.textContent).toContain('const burst = 5')
  })

  test('the file heading opens that file in Changes at its first comment', async () => {
    mocked.getDraftSnippets.mockResolvedValue({ d1: snippet() })
    await seed({ drafts: [draft('d1', { line: 12 })] })

    await act(async () => {
      fireEvent.click(el('pr-draft-group-open'))
    })

    const state = usePrInboxStore.getState()
    expect(state.activeTab).toBe('files')
    expect(state.reviewViews['sess-1']).toBe('changes')
    expect(state.pendingReveal).toEqual({ path: '/src/app/sync/rateLimiter.ts', line: 12 })
    expect(state.activeFilePath).toBe('/src/app/sync/rateLimiter.ts')
  })

  test('a comment anchor opens the diff at that comment, not at the file heading', async () => {
    mocked.getDraftSnippets.mockResolvedValue({ d1: snippet(), d2: snippet({ anchorLine: 30 }) })
    await seed({ drafts: [draft('d1', { line: 12 }), draft('d2', { line: 30 })] })

    await act(async () => {
      fireEvent.click(all('pr-draft-open')[1])
    })

    expect(usePrInboxStore.getState().pendingReveal).toEqual({
      path: '/src/app/sync/rateLimiter.ts',
      line: 30
    })
  })

  test('a draft whose code could not be read still gets its decisions, and says so', async () => {
    mocked.getDraftSnippets.mockResolvedValue({ d1: null })
    await seed({ drafts: [draft('d1')] })

    expect(all('pr-draft-snippet')).toHaveLength(0)
    expect(el('pr-draft-snippet-missing').textContent).toContain('could not be read')
    expect(el('pr-draft').textContent).toContain('Finding d1')
  })

  test('a failed snippet read is admitted once and offers a retry, drafts intact', async () => {
    mocked.getDraftSnippets.mockRejectedValue(new Error('no local clone'))
    await seed({ drafts: [draft('d1')] })

    expect(el('pr-draft-snippets-error')).toBeTruthy()
    expect(el('pr-draft').textContent).toContain('Finding d1')
    // One failed attempt, then it waits to be asked again: no retry loop against the missing clone.
    expect(mocked.getDraftSnippets).toHaveBeenCalledTimes(1)

    mocked.getDraftSnippets.mockResolvedValue({ d1: snippet() })
    await act(async () => {
      fireEvent.click(el('pr-draft-snippets-error').querySelector('button')!)
    })
    expect(el('pr-draft-snippet').textContent).toContain('const burst = 5')
  })

  test('a comment recorded while the summary is open picks up its code', async () => {
    mocked.getDraftSnippets.mockResolvedValue({ d1: snippet() })
    await seed({ drafts: [draft('d1')] })
    expect(mocked.getDraftSnippets).toHaveBeenCalledTimes(1)

    mocked.getDraftSnippets.mockResolvedValue({
      d1: snippet(),
      d2: snippet({ lines: ['const drained = true'] })
    })
    await act(async () => {
      usePrInboxStore.setState({ drafts: [draft('d1'), draft('d2', { line: 20 })] })
    })

    expect(mocked.getDraftSnippets).toHaveBeenCalledTimes(2)
    expect(all('pr-draft-snippet')[1].textContent).toContain('const drained = true')
  })

  test('snippets already in hand are not fetched again on re-render', async () => {
    mocked.getDraftSnippets.mockResolvedValue({ d1: snippet() })
    await seed({ drafts: [draft('d1')] })

    await act(async () => {
      usePrInboxStore.setState({ activeFilePath: '/src/other.ts' })
    })

    expect(mocked.getDraftSnippets).toHaveBeenCalledTimes(1)
  })
})
