import type { WorkItemSource, WorkItemState } from '@common/domain'

/**
 * What each source's cache can answer about a work item's continued existence. Injected so the
 * state rules stay a pure function over the answers.
 */
export interface WorkItemStateDeps {
  /** Whether any Jira source's cache still returns the issue (see JiraCacheRepo.issuePresence). */
  jiraIssuePresence(issueKey: string): 'present' | 'absent' | 'unknown'
  /** Whether the TODO task row still exists (done tasks do; hard-deleted ones do not). */
  todoExists(taskId: string): boolean
  /** Whether the PR is still in the replace-on-sync PR cache. */
  prCached(repositoryId: string, prId: number): boolean
}

/**
 * Split a PR external key (`${repositoryId}:${prId}`) back into its parts. The repository id may
 * itself contain no colon (it is a GUID), but splitting on the last colon keeps this safe even if
 * that ever changes. Null for a malformed key.
 */
export function parsePrExternalKey(
  externalKey: string
): { repositoryId: string; prId: number } | null {
  const i = externalKey.lastIndexOf(':')
  if (i <= 0 || i === externalKey.length - 1) return null
  const prId = Number(externalKey.slice(i + 1))
  if (!Number.isInteger(prId)) return null
  return { repositoryId: externalKey.slice(0, i), prId }
}

/**
 * A ref's liveness, computed on every read and never stored. The rules weigh each source's
 * evidence: a Jira row flagged absent is soft evidence ('stale') while no cached row anywhere is
 * hard ('missing'); a hard-deleted TODO is hard evidence ('missing'), a done one is still
 * 'linked'; a PR gone from the cache is only ever 'stale' - the PR cache is replaced whole on
 * every sync, so absence proves nothing about the PR itself.
 */
export function computeWorkItemState(
  source: WorkItemSource,
  externalKey: string,
  deps: WorkItemStateDeps
): WorkItemState {
  switch (source) {
    case 'jira': {
      const presence = deps.jiraIssuePresence(externalKey)
      if (presence === 'present') return 'linked'
      return presence === 'absent' ? 'stale' : 'missing'
    }
    case 'todo':
      return deps.todoExists(externalKey) ? 'linked' : 'missing'
    case 'ado-pr': {
      const parsed = parsePrExternalKey(externalKey)
      return parsed !== null && deps.prCached(parsed.repositoryId, parsed.prId)
        ? 'linked'
        : 'stale'
    }
  }
}
