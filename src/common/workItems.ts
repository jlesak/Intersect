import type { NewWorkItemRef } from './domain'
import { prOverrideKey } from './projectAssign'

/**
 * The one place a work-item ref is built from each source's raw item, shared by the core's
 * candidate search and the renderer's card launches so external keys and display snapshots
 * can never drift between the two sides.
 */

/** A ref to a Jira issue; the external key is the issue key itself. */
export function jiraWorkItem(
  issue: { key: string; summary: string },
  projectId: string | null
): NewWorkItemRef {
  return {
    source: 'jira',
    externalKey: issue.key,
    projectId,
    snapshot: { key: issue.key, title: issue.summary, type: 'issue' }
  }
}

/** A ref to a local TODO task. Todos carry no project, so the ref always lands in Other. */
export function todoWorkItem(task: { id: string; text: string }): NewWorkItemRef {
  return {
    source: 'todo',
    externalKey: task.id,
    projectId: null,
    snapshot: { key: 'TODO', title: task.text, type: 'task' }
  }
}

/** A ref to an ADO pull request; the external key reuses the PR project-override key. */
export function prWorkItem(
  pr: { repositoryId: string; prId: number; title: string },
  projectId: string | null
): NewWorkItemRef {
  return {
    source: 'ado-pr',
    externalKey: prOverrideKey(pr.repositoryId, pr.prId),
    projectId,
    snapshot: { key: `!${pr.prId}`, title: pr.title, type: 'pull-request' }
  }
}

/** Longest tab title a work item may default to before the text is ellipsized. */
const TAB_TITLE_MAX = 30

/**
 * The default tab title a freshly launched session takes from its work item: the issue key for
 * Jira, the (truncated) task text for a TODO, and 'PR !<id>' for a pull request. Only a default -
 * renaming the tab later never touches the ref.
 */
export function workItemTabTitle(ref: NewWorkItemRef): string {
  if (ref.source === 'todo') {
    const text = ref.snapshot.title.trim()
    return text.length > TAB_TITLE_MAX ? `${text.slice(0, TAB_TITLE_MAX - 1).trimEnd()}…` : text
  }
  if (ref.source === 'ado-pr') return `PR ${ref.snapshot.key}`
  return ref.snapshot.key
}
