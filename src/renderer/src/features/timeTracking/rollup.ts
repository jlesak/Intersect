import type { Project, ProjectOverride, TimeEntry } from '@common/domain'
import { effectiveProject, indexOverrides, resolveJiraProject } from '@common/projectAssign'

/**
 * Weekly rollups over the entries the board already holds: what the week added up to per issue and
 * per project. Both are pure derivations of the same list the grand total is computed from, so the
 * buckets always sum to the figure in the topbar. Nothing here filters, because a rollup that drops
 * a card the board shows would put two disagreeing totals on one screen.
 */

/** The bucket holding time that carries no issue key at all (meetings, reviews, interruptions). */
export const NO_ISSUE_KEY = '__no_issue__'

/** The bucket holding time no project claims, matching the sidebar's virtual Other pin. */
export const OTHER_PROJECT_KEY = '__other__'

/**
 * One line of a rollup: a bucket with what it holds and what it adds up to. `catchAll` marks the
 * bucket that takes whatever nothing else claimed, which is rendered as the placeholder it is and
 * always sorted last.
 */
export interface RollupRow {
  key: string
  label: string
  totalMs: number
  entries: number
  catchAll: boolean
}

/** Add one entry's span to its bucket, creating the bucket on first sight. */
function accumulate(
  buckets: Map<string, RollupRow>,
  key: string,
  label: string,
  catchAll: boolean,
  durationMs: number
): void {
  const row = buckets.get(key)
  if (row) {
    row.totalMs += durationMs
    row.entries += 1
    return
  }
  buckets.set(key, { key, label, totalMs: durationMs, entries: 1, catchAll })
}

/** Heaviest bucket first, name as the stable tie, and the catch-all bucket always at the end. */
function ordered(buckets: Map<string, RollupRow>): RollupRow[] {
  return [...buckets.values()].sort(
    (a, b) =>
      Number(a.catchAll) - Number(b.catchAll) ||
      b.totalMs - a.totalMs ||
      a.label.localeCompare(b.label)
  )
}

/** The week's time per issue key, with unattributed time gathered under `No issue`. */
export function rollupByIssue(entries: TimeEntry[]): RollupRow[] {
  const buckets = new Map<string, RollupRow>()
  for (const e of entries) {
    if (e.issueKey === null) accumulate(buckets, NO_ISSUE_KEY, 'No issue', true, e.durationMs)
    else accumulate(buckets, e.issueKey, e.issueKey, false, e.durationMs)
  }
  return ordered(buckets)
}

/**
 * The week's time per project, resolved from each entry's issue key exactly as the issue and PR
 * boards resolve theirs, so a project's hours agree with its issue count. A manual assignment of an
 * issue to a project therefore also moves that issue's logged time, including in past weeks: the
 * assignment is a statement about the issue, and the time was spent on the issue.
 */
export function rollupByProject(
  entries: TimeEntry[],
  projects: Project[],
  overrides: ProjectOverride[]
): RollupRow[] {
  const index = indexOverrides(overrides)
  const nameById = new Map(projects.map((p) => [p.id, p.name]))
  const buckets = new Map<string, RollupRow>()
  for (const e of entries) {
    const projectId =
      e.issueKey === null
        ? null
        : effectiveProject('jira', e.issueKey, resolveJiraProject(e.issueKey, projects), index)
    // An id with no project behind it is an override left by a deleted project, which claims
    // nothing any more and belongs with the rest of the unclaimed time.
    const name = projectId === null ? undefined : nameById.get(projectId)
    if (projectId === null || name === undefined) {
      accumulate(buckets, OTHER_PROJECT_KEY, 'Other', true, e.durationMs)
    } else {
      accumulate(buckets, projectId, name, false, e.durationMs)
    }
  }
  return ordered(buckets)
}
