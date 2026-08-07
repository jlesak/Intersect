import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'

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
