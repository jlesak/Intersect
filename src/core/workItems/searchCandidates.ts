import type {
  JiraIssueSnapshot,
  NewWorkItemRef,
  Project,
  ProjectOverride,
  PullRequest,
  TodoTask,
  WorkItemCandidateGroup
} from '@common/domain'
import {
  effectiveProject,
  indexOverrides,
  prOverrideKey,
  resolveJiraProject,
  resolvePrProject
} from '@common/projectAssign'
import { jiraWorkItem, prWorkItem, todoWorkItem } from '@common/workItems'

/** The corpus one candidate search runs over: every source's cache plus the project plumbing. */
export interface WorkItemSearchData {
  /** Cached Jira issues, already deduplicated by key across sources. */
  jiraIssues: JiraIssueSnapshot[]
  openTodos: TodoTask[]
  prs: PullRequest[]
  projects: Project[]
  overrides: ProjectOverride[]
}

/**
 * The picker's search: match the query case-insensitively against each item's key and title,
 * group by source, and prebuild a ready-to-assign ref per candidate with its effective project
 * resolved (manual overrides beat binding inference; todos always land in Other). An empty query
 * returns everything. `rankProjectId` floats the given project's candidates to the top of each
 * group (undefined skips the ranking, e.g. when no workspace is in context); ties keep the
 * source cache's own order.
 */
export function searchWorkItemCandidates(
  query: string,
  rankProjectId: string | null | undefined,
  data: WorkItemSearchData
): WorkItemCandidateGroup[] {
  const q = query.trim().toLowerCase()
  const matches = (...fields: string[]): boolean =>
    q === '' || fields.some((field) => field.toLowerCase().includes(q))
  const overrides = indexOverrides(data.overrides)

  const jira = data.jiraIssues
    .filter((issue) => matches(issue.key, issue.summary))
    .map((issue) =>
      jiraWorkItem(
        issue,
        effectiveProject(
          'jira',
          issue.key,
          resolveJiraProject(issue.key, data.projects),
          overrides
        )
      )
    )

  const todos = data.openTodos.filter((task) => matches(task.text)).map(todoWorkItem)

  const prs = data.prs
    .filter((pr) => matches(pr.title, pr.repositoryName, `!${pr.prId}`))
    .map((pr) =>
      prWorkItem(
        pr,
        effectiveProject(
          'pr',
          prOverrideKey(pr.repositoryId, pr.prId),
          resolvePrProject(pr.repositoryName, data.projects),
          overrides
        )
      )
    )

  const rank = (candidates: NewWorkItemRef[]): NewWorkItemRef[] =>
    rankProjectId === undefined
      ? candidates
      : [...candidates].sort(
          (a, b) =>
            Number(b.projectId === rankProjectId) - Number(a.projectId === rankProjectId)
        )

  const groups: WorkItemCandidateGroup[] = []
  if (jira.length > 0) groups.push({ source: 'jira', candidates: rank(jira) })
  if (todos.length > 0) groups.push({ source: 'todo', candidates: rank(todos) })
  if (prs.length > 0) groups.push({ source: 'ado-pr', candidates: rank(prs) })
  return groups
}
