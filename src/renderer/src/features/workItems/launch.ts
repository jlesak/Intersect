import type { JiraIssue, PullRequest, TodoTask } from '@common/domain'
import {
  effectiveProject,
  indexOverrides,
  prOverrideKey,
  resolveJiraProject,
  resolvePrProject
} from '@common/projectAssign'
import { jiraWorkItem, prWorkItem, todoWorkItem } from '@common/workItems'
import { useProjectsStore } from '@renderer/features/projects'
import { useWorkItemsStore } from './store'

/**
 * Card-launch entry points shared by every surface (kanban cards, TODO rows, PR lists): resolve
 * the item's effective project, pick the session's home folder from that project's primary
 * repository binding, and record the launch intent for the app-layer wiring to execute.
 *
 * A card launch opens in the project's main checkout - no worktree is created or chosen here.
 * The one exception is fixing my own pull request's comments, whose worktree the core prepares.
 */

/** The primary repository folder of a project, or null when it has none (or project = Other). */
function projectFolder(projectId: string | null): string | null {
  if (projectId === null) return null
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
  return project?.repoPaths[0] ?? null
}

/** Launch a Claude session working on a Jira issue, homed in the issue's effective project. */
export function launchFromJiraIssue(issue: JiraIssue): void {
  const { projects, overrides } = useProjectsStore.getState()
  const projectId = effectiveProject(
    'jira',
    issue.key,
    resolveJiraProject(issue.key, projects),
    indexOverrides(overrides)
  )
  useWorkItemsStore.getState().requestLaunch({
    ref: jiraWorkItem(issue, projectId),
    folderPath: projectFolder(projectId)
  })
}

/** Launch a Claude session working on a TODO task, homed in the selected workspace. */
export function launchFromTodoTask(task: TodoTask): void {
  useWorkItemsStore.getState().requestLaunch({ ref: todoWorkItem(task), folderPath: null })
}

/** The project a pull request belongs to: a manual override, else its repository's binding. */
function prProject(pr: PullRequest): string | null {
  const { projects, overrides } = useProjectsStore.getState()
  return effectiveProject(
    'pr',
    prOverrideKey(pr.repositoryId, pr.prId),
    resolvePrProject(pr.repositoryName, projects),
    indexOverrides(overrides)
  )
}

/** Launch a Claude session working on a pull request, homed in the PR's effective project. */
export function launchFromPullRequest(pr: PullRequest): void {
  const projectId = prProject(pr)
  useWorkItemsStore.getState().requestLaunch({
    ref: prWorkItem(pr, projectId),
    folderPath: projectFolder(projectId)
  })
}

/**
 * Open the Claude tab that fixes my pull request's review comments, in the worktree the core
 * prepared for it. With `openTab` false a tab is already open there, so its workspace is only
 * brought forward.
 */
export function launchPullRequestFix(pr: PullRequest, folderPath: string, openTab: boolean): void {
  useWorkItemsStore.getState().requestLaunch({
    ref: prWorkItem(pr, prProject(pr)),
    folderPath,
    openTab
  })
}
