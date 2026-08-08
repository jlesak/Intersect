import type { PullRequest } from '@common/domain'
import { fuzzyFilter } from '@renderer/shared/fuzzy'
import {
  type FilterOption,
  type Selection,
  matchesSelection,
  reconcileSelection
} from '@renderer/shared/selection'

/** How the user has narrowed the PR board: what they typed, and which repositories they kept. */
export interface PrBoardFilter {
  query: string
  repos: Selection
}

/** The board as it stands before the user narrows anything: every pull request shown. */
export const NO_PR_FILTER: PrBoardFilter = { query: '', repos: null }

/**
 * The pull requests a board should show under the given filter, in the order they arrived.
 *
 * A pull request is as often remembered by its number as by its title, so the number is offered to
 * the matcher in the `!123` form Azure DevOps writes it in - which finds it whether or not the
 * user typed the mark. As on the Jira board, the matcher's ranking only decides what survives:
 * each column keeps its own most-recently-active-first order.
 *
 * The repository selection is read against the repositories the board can currently offer, so a
 * repository that drops out of a sync can never go on hiding everything by a chip that is no
 * longer on screen to be cleared.
 */
export function filterPrs(prs: readonly PullRequest[], filter: PrBoardFilter): PullRequest[] {
  const available = prFilterOptions(prs).repos.map((option) => option.value)
  const repos = reconcileSelection(filter.repos, available)
  const chosen = prs.filter((pr) => matchesSelection(repos, [pr.repositoryId]))
  const matched = new Set(
    fuzzyFilter(filter.query, chosen, (pr) => [
      pr.title,
      pr.repositoryName,
      pr.authorName,
      `!${pr.prId}`
    ])
  )
  return chosen.filter((pr) => matched.has(pr))
}

/**
 * What the board's repository chip can offer, derived from the pull requests actually on it.
 * Keyed by repository id, because that is what identifies a repository; the name is only what the
 * user reads. There is no "(none)" choice here: a pull request always came from somewhere.
 */
export function prFilterOptions(prs: readonly PullRequest[]): { repos: FilterOption[] } {
  const repos = new Map<string, string>()
  for (const pr of prs) repos.set(pr.repositoryId, pr.repositoryName)
  return {
    repos: [...repos]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }
}
