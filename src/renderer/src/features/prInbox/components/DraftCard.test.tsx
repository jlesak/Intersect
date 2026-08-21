import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftComment } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { usePrInboxStore } from '../store'
import { DraftCard } from './DraftCard'

const mocked = vi.mocked(api)

const draft = (over: Partial<DraftComment> = {}): DraftComment => ({
  id: 'draft-1',
  prId: 1,
  repositoryId: 'repo-1',
  filePath: '/src/core/sync.ts',
  line: 42,
  side: 'right',
  body: 'This retry loop never backs off.',
  status: 'pending',
  source: 'claude',
  reviewSessionId: 'review-1',
  sourceCommitId: 'a',
  publishedThreadId: null,
  createdAt: 1,
  ...over
})

const button = (testId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!

/**
 * Approving a draft is the reviewer's decision on a body and anchor already on screen, so the click
 * has to reach Azure DevOps on its own.
 */
describe('DraftCard approve', () => {
  beforeEach(() => {
    usePrInboxStore.setState({ selectedKey: 'repo-1:1', drafts: [draft()], unfinishedReviews: {} })
  })

  afterEach(() => {
    usePrInboxStore.setState({ selectedKey: null, drafts: [] })
    vi.resetAllMocks()
  })

  test('publishes on the first click, with no confirmation in between', async () => {
    mocked.publishDraft.mockResolvedValue(draft({ status: 'published', publishedThreadId: 7 }))
    await act(async () => {
      render(<DraftCard draft={draft()} />)
    })

    await act(async () => {
      fireEvent.click(button('pr-draft-approve'))
    })

    expect(mocked.publishDraft).toHaveBeenCalledWith('draft-1')
    expect(usePrInboxStore.getState().drafts).toEqual([])
  })

  test('a stale draft still refuses to publish', async () => {
    await act(async () => {
      render(<DraftCard draft={draft()} stale />)
    })

    expect(button('pr-draft-approve').disabled).toBe(true)
    await act(async () => {
      fireEvent.click(button('pr-draft-approve'))
    })
    expect(mocked.publishDraft).not.toHaveBeenCalled()
  })
})
