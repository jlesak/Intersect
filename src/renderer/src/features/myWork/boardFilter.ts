import type { JiraIssueSnapshot } from '@common/domain'
import { fuzzyFilter } from '@renderer/shared/fuzzy'
import { type FilterOption, type Selection, matchesSelection } from '@renderer/shared/selection'

/** How the user has narrowed a Jira board: what they typed, and which epics and components they kept. */
export interface JiraBoardFilter {
  query: string
  epics: Selection
  components: Selection
}

/** The board as it stands before the user narrows anything: every issue shown. */
export const NO_JIRA_FILTER: JiraBoardFilter = { query: '', epics: null, components: null }

/**
 * The issues a board should show under the given filter, in the order they arrived.
 *
 * The shared matcher ranks its hits, but a kanban column is read as a queue ordered by activity,
 * so the ranking is used only to decide what survives: reordering cards under the user's cursor as
 * they type would fight the column's own sort, and a score is meaningless across two columns
 * anyway.
 */
export function filterJiraIssues(
  issues: readonly JiraIssueSnapshot[],
  filter: JiraBoardFilter
): JiraIssueSnapshot[] {
  const chosen = issues.filter(
    (issue) =>
      matchesSelection(filter.epics, issue.epicKey === null ? [] : [issue.epicKey]) &&
      matchesSelection(filter.components, issue.components)
  )
  const matched = new Set(
    fuzzyFilter(filter.query, chosen, (issue) => [issue.key, issue.summary, issue.assignee ?? ''])
  )
  return chosen.filter((issue) => matched.has(issue))
}

const byLabel = (a: FilterOption, b: FilterOption): number => a.label.localeCompare(b.label)

/**
 * What the board's chip filters can offer, derived from the issues actually on it. A field the
 * remote system never fills - a Jira epic link that was never configured, say - yields nothing,
 * which is what keeps a dead control off the screen instead of an empty one.
 */
export function jiraFilterOptions(issues: readonly JiraIssueSnapshot[]): {
  epics: FilterOption[]
  components: FilterOption[]
} {
  const epics = new Map<string, string>()
  const components = new Set<string>()
  for (const issue of issues) {
    // Epic summaries are enriched best-effort, so one issue may name an epic another only points
    // at. The name wins wherever it turns up, rather than whichever issue happened to come last.
    if (issue.epicKey !== null && (issue.epicSummary !== null || !epics.has(issue.epicKey))) {
      epics.set(issue.epicKey, issue.epicSummary ?? issue.epicKey)
    }
    for (const name of issue.components) components.add(name)
  }
  return {
    epics: [...epics].map(([value, label]) => ({ value, label })).sort(byLabel),
    components: [...components].sort().map((value) => ({ value, label: value }))
  }
}
