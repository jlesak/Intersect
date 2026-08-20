import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useProjectsStore } from '../store'
import { ProjectPrList } from './ProjectPrList'

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    prId: 7,
    repositoryId: 'repo-1',
    repositoryName: 'spot-backend',
    projectId: 'ado',
    title: 'Fix the sync',
    description: '',
    authorId: 'u1',
    authorName: 'Jan',
    createdAt: 1,
    status: 'active',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    sourceCommitId: 'a',
    targetCommitId: 'b',
    url: 'https://ado/pr/7',
    role: 'reviewer',
    myVote: null,
    myReviewerId: null,
    reviewers: [],
    newChangesSinceMyReview: false,
    activeThreadCount: 0,
    lastActivityAt: 1,
    ...over
  }
}

/**
 * The store-reading Pull Requests panel of a project context, mounted client-side. Static markup
 * cannot expose a re-render loop, so only a real root exercises how the panel subscribes to the
 * PR-inbox list.
 */
describe('ProjectPrList', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    usePrInboxStore.setState({ status: 'idle', error: null, prsByKey: {}, order: [] })
  })

  /** The bridge call the panel makes on mount, so a client render can reach a ready state. */
  function stubBridge(prs: PullRequest[]): void {
    ;(window as { intersect?: unknown }).intersect = {
      prInbox: {
        list: () => Promise.resolve(prs),
        listUnfinishedDraftReviews: () => Promise.resolve([])
      }
    }
  }

  test('mounts and settles without a render loop', async () => {
    stubBridge([])
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<ProjectPrList projectId="p1" />)
      })

      expect(logged).toEqual([])
      expect(document.querySelector('.ix-empty')).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('lists the cached PRs of the project’s bound repositories', async () => {
    stubBridge([pr()])
    useProjectsStore.setState({
      status: 'ready',
      error: null,
      overrides: [],
      projects: [
        {
          id: 'p1',
          name: 'SPOT',
          sortOrder: 0,
          archived: false,
          repoPaths: ['/repos/spot'],
          jiraJql: null,
          jiraBoardUrl: null,
          adoRepositories: ['spot-backend']
        }
      ]
    })

    await act(async () => {
      render(<ProjectPrList projectId="p1" />)
    })

    const rows = [...document.querySelectorAll('.ix-ctx__row-title')].map((e) => e.textContent)
    expect(rows).toEqual(['Fix the sync'])
  })
})
