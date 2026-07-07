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

  test('publishing stays unavailable in the stub', async () => {
    const stub = createAdoE2eStub({ INTERSECT_E2E_ADO: 'radar' })
    await expect(
      stub.publishComment({ repositoryId: 'e2e-repo', prId: 502, filePath: 'a.ts', line: 1, body: 'x' })
    ).rejects.toThrow(/not available/i)
  })
})
