import { describe, expect, test } from 'vitest'
import { createAdoE2eStub } from './adoE2eStub'

describe('adoE2eStub', () => {
  test('radar mode resolves my reviewer entry only where I actually review', async () => {
    const stub = createAdoE2eStub({ INTERSECT_E2E_ADO: 'radar' })
    const { prs } = await stub.syncMyPrs()
    const byId = new Map(prs.map((p) => [p.prId, p]))
    expect(byId.get(501)?.myReviewerId).toBeNull()
    expect(byId.get(502)?.myReviewerId).toBe('me')
    expect(byId.get(503)?.myReviewerId).toBe('me')
  })

  test('a cast vote is reflected by every later sync, on myVote and my reviewer entry alike', async () => {
    const stub = createAdoE2eStub({ INTERSECT_E2E_ADO: 'radar' })
    await stub.castVote('e2e-repo', 502, 'me', 'approved')
    const { prs } = await stub.syncMyPrs()
    const voted = prs.find((p) => p.prId === 502)
    expect(voted?.myVote).toBe('approved')
    expect(voted?.reviewers).toEqual([
      { id: 'me', displayName: 'Jan Lesak', vote: 'approved', isRequired: true }
    ])
    // The other PRs stay untouched.
    expect(prs.find((p) => p.prId === 503)?.myVote).toBe('approved')
    expect(prs.find((p) => p.prId === 501)?.myVote).toBeNull()
  })

  test('publishing adds a thread that later reads and syncs reflect', async () => {
    const stub = createAdoE2eStub({ INTERSECT_E2E_ADO: 'radar' })
    const threadId = await stub.publishComment({
      repositoryId: 'e2e-repo',
      prId: 502,
      filePath: 'a.ts',
      line: 1,
      body: 'x'
    })
    const threads = await stub.getThreads('e2e-repo', 502)
    expect(threads.map((t) => t.threadId)).toContain(threadId)
    // The new unresolved thread shows up in the PR's sync-time count.
    const { prs } = await stub.syncMyPrs()
    expect(prs.find((p) => p.prId === 502)?.activeThreadCount).toBe(1)
  })

  test('reply appends to the thread and resolve flips its status', async () => {
    const stub = createAdoE2eStub({ INTERSECT_E2E_ADO: 'radar' })
    await stub.replyToThread({ repositoryId: 'e2e-repo', prId: 501, threadId: 9001, body: 'done' })
    let threads = await stub.getThreads('e2e-repo', 501)
    expect(threads.find((t) => t.threadId === 9001)?.comments).toHaveLength(2)
    await stub.setThreadStatus({ repositoryId: 'e2e-repo', prId: 501, threadId: 9001, status: 'fixed' })
    threads = await stub.getThreads('e2e-repo', 501)
    expect(threads.find((t) => t.threadId === 9001)?.status).toBe('fixed')
    // Resolving the only unresolved thread clears the author-side action signal.
    const { prs } = await stub.syncMyPrs()
    expect(prs.find((p) => p.prId === 501)?.activeThreadCount).toBe(0)
  })
})
