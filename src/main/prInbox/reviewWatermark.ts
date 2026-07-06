import type { PullRequest } from '@common/domain'

/**
 * Pure watermark logic for the "new changes since my review" radar group. A watermark records the
 * source commit a PR pointed at when I last voted on it; the PR drifting past that commit means
 * the author pushed changes I have not reviewed. Kept free of any DB/Electron import so the
 * transition rules are unit-testable on their own.
 */

export interface WatermarkUpsert {
  repositoryId: string
  prId: number
  votedCommitId: string
}

export interface WatermarkDelete {
  repositoryId: string
  prId: number
}

/** The watermark writes one sync produces: rows to (re)seed and rows to drop. */
export interface WatermarkPlan {
  upserts: WatermarkUpsert[]
  deletes: WatermarkDelete[]
}

const key = (pr: { repositoryId: string; prId: number }): string => `${pr.repositoryId}:${pr.prId}`

const hasStandingVote = (pr: PullRequest): boolean => pr.myVote !== null && pr.myVote !== 'noVote'

/**
 * Decide how the watermarks move for one sync, comparing the fresh PR list against the cache as it
 * was before this sync overwrote it:
 *
 * - I just voted (no cached row, a cached row without a recorded vote, or a different vote): the
 *   watermark is (re)seeded to the PR's current source commit - I am caught up as of now. The
 *   first sync after the watermark table is introduced hits this rule for every already-voted PR,
 *   so past reviews are never retroactively flagged.
 * - My vote is unchanged: the watermark stays put, which is what keeps the "new changes" flag
 *   alive across syncs while the author keeps pushing.
 * - I have no standing vote (noVote, or I am no longer among the reviewers): the watermark is
 *   dropped; the PR belongs to "waiting on my review" instead.
 *
 * Watermarks of PRs absent from the sync entirely are pruned by the caller
 * (see PrReviewWatermarkRepo.prune).
 */
export function planWatermarks(oldPrs: PullRequest[], newPrs: PullRequest[]): WatermarkPlan {
  const oldByKey = new Map(oldPrs.map((pr) => [key(pr), pr]))
  const plan: WatermarkPlan = { upserts: [], deletes: [] }
  for (const pr of newPrs) {
    if (!hasStandingVote(pr)) {
      plan.deletes.push({ repositoryId: pr.repositoryId, prId: pr.prId })
      continue
    }
    // A vote on a PR I authored never feeds the radar (the grouping is reviewer-only), so an
    // author's watermark is left alone rather than seeded or churned.
    if (pr.role !== 'reviewer') continue
    const old = oldByKey.get(key(pr))
    if (!old || old.myVote === null || old.myVote !== pr.myVote) {
      plan.upserts.push({
        repositoryId: pr.repositoryId,
        prId: pr.prId,
        votedCommitId: pr.sourceCommitId
      })
    }
  }
  return plan
}

/**
 * Stamp `newChangesSinceMyReview` onto PRs read from the cache: true iff a watermark exists and
 * the PR's source commit moved past it. Computed on every read, never persisted.
 */
export function decorateNewChanges(
  prs: PullRequest[],
  watermarkFor: (repositoryId: string, prId: number) => { votedCommitId: string } | undefined
): PullRequest[] {
  return prs.map((pr) => {
    const watermark = watermarkFor(pr.repositoryId, pr.prId)
    return {
      ...pr,
      newChangesSinceMyReview:
        watermark !== undefined && watermark.votedCommitId !== pr.sourceCommitId
    }
  })
}
