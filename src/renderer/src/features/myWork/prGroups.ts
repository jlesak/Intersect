import type { PullRequest } from '@common/domain'

/**
 * The My Work PR radar's three subgroups, in display order. Only active PRs qualify anywhere; a PR
 * I reviewed that has not changed since ("caught up") belongs to no group and stays off the radar.
 */
export interface PrGroups {
  /** PRs I authored, still waiting for approvals/merge. */
  myPrs: PullRequest[]
  /** PRs where I am a reviewer and have not cast a vote yet. */
  waitingOnMe: PullRequest[]
  /** PRs I already voted on where the author pushed new changes since. */
  updatedSinceReview: PullRequest[]
}

const newestFirst = (a: PullRequest, b: PullRequest): number => b.createdAt - a.createdAt

/** Split the cached PR list into the radar's subgroups, each sorted newest first. */
export function groupPrs(prs: PullRequest[]): PrGroups {
  const active = prs.filter((pr) => pr.status === 'active')
  return {
    myPrs: active.filter((pr) => pr.role === 'author').sort(newestFirst),
    waitingOnMe: active
      .filter((pr) => pr.role === 'reviewer' && (pr.myVote === null || pr.myVote === 'noVote'))
      .sort(newestFirst),
    updatedSinceReview: active
      .filter(
        (pr) =>
          pr.role === 'reviewer' &&
          pr.myVote !== null &&
          pr.myVote !== 'noVote' &&
          pr.newChangesSinceMyReview
      )
      .sort(newestFirst)
  }
}

/** How many reviewers have approved the PR (with or without suggestions). */
export function approvalCount(pr: PullRequest): number {
  return pr.reviewers.filter((r) => r.vote === 'approved' || r.vote === 'approvedWithSuggestions')
    .length
}

/** Avatar initials from a display name: first letter of the first two words ("Jan Lesak" -> "JL"). */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}
