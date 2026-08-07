import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PrChangeFile, PullRequest } from '@common/domain'

// The detail reaches the Monaco diff through its imports, and monaco cannot initialise under jsdom.
vi.mock('monaco-editor', () => ({ editor: {} }))

import { usePrInboxStore } from '../store'
import { PrDetail } from './PrDetail'

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
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
    sourceCommitId: 'a',
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
  }
}

const seed = async (
  over: Partial<PullRequest> = {},
  adoOrgUrl = 'https://devops.example.com/tfs/DefaultCollection'
): Promise<void> => {
  usePrInboxStore.setState({
    prsByKey: { 'repo-1:1': pr(over) },
    order: ['repo-1:1'],
    selectedKey: 'repo-1:1',
    view: 'detail',
    activeTab: 'overview',
    adoOrgUrl
  })
  await act(async () => {
    render(<PrDetail />)
  })
}

const button = (testId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!

describe('PrDetail header links', () => {
  afterEach(() => {
    usePrInboxStore.setState({ selectedKey: null, view: 'board', threads: [], threadsLoaded: false })
  })

  test('offers the Azure DevOps link and the copy action', async () => {
    await seed()
    expect(button('pr-open-external').disabled).toBe(false)
    expect(button('pr-copy-link').disabled).toBe(false)
  })

  test('both are dead while no Azure DevOps organisation is configured', async () => {
    // Nothing addresses a page without the organisation URL, and a half-built one would open the
    // browser on garbage.
    await seed({}, '')
    expect(button('pr-open-external').disabled).toBe(true)
    expect(button('pr-copy-link').disabled).toBe(true)
    expect(button('pr-open-external').title).toContain('Settings')
  })

  test('both are dead for a PR the server named no repository for', async () => {
    await seed({ repositoryName: '' })
    expect(button('pr-open-external').disabled).toBe(true)
    expect(button('pr-copy-link').disabled).toBe(true)
  })
})

const change = (
  path: string,
  added: number,
  removed: number,
  changeType: PrChangeFile['changeType'] = 'edit'
): PrChangeFile => ({ path, changeType, originalPath: null, added, removed })

const CHANGES: PrChangeFile[] = [
  change('/src/sync/rateLimiter.ts', 120, 34),
  change('/src/sync/queue.ts', 20, 7),
  change('/assets/logo.png', 0, 0, 'add')
]

const seedChanges = async (changes: PrChangeFile[]): Promise<void> => {
  usePrInboxStore.setState({
    prsByKey: { 'repo-1:1': pr() },
    order: ['repo-1:1'],
    selectedKey: 'repo-1:1',
    view: 'detail',
    activeTab: 'overview',
    adoOrgUrl: 'https://devops.example.com/tfs/DefaultCollection',
    changes,
    changesError: null,
    threads: [],
    threadsLoaded: true
  })
  await act(async () => {
    render(<PrDetail />)
  })
}

const sizeSummary = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="pr-size"]')

describe('PrDetail change size', () => {
  afterEach(() => {
    usePrInboxStore.setState({ selectedKey: null, view: 'board', changes: [], threads: [] })
  })

  test('the header says how big the change is before the reviewer opens a single file', async () => {
    await seedChanges(CHANGES)

    expect(sizeSummary()!.textContent).toBe('3 files · +140 -41')
  })

  test('one changed file is counted in the singular', async () => {
    await seedChanges([change('/src/only.ts', 1, 1)])

    expect(sizeSummary()!.textContent).toBe('1 file · +1 -1')
  })

  test('a PR whose changes have not arrived claims no size at all', async () => {
    // An empty list is what "not loaded" looks like, and "0 files" would be a claim about the PR.
    await seedChanges([])

    expect(sizeSummary()).toBeNull()
  })

  test('each file in the tree carries its own counts', async () => {
    await seedChanges(CHANGES)
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="pr-tab-files"]')!)
    })

    const rows = [...document.querySelectorAll('[data-testid="tree-file"]')].map(
      (el) => el.textContent ?? ''
    )
    expect(rows.some((r) => r.includes('rateLimiter.ts') && r.includes('+120') && r.includes('-34'))).toBe(true)
    expect(rows.some((r) => r.includes('queue.ts') && r.includes('+20') && r.includes('-7'))).toBe(true)
    // A file git counted no lines for says nothing rather than "+0 -0".
    const logo = rows.find((r) => r.includes('logo.png'))!
    expect(logo).not.toContain('+0')
    expect(logo).not.toContain('-0')
  })
})
