import type { PullRequest, TimeEntry, TodoTask } from '@common/domain'
import { boardColumn, boardReason } from '@common/prBoard'
import { dayKeyOf, weekStartOf } from '@common/week'
import { isDueToday, isOverdue } from '@renderer/features/todo'

/**
 * Every derivation behind the four zones, as pure functions over the store slices that feed them.
 *
 * They live outside the components on purpose. The Dashboard is the app's landing view, and a
 * selector that builds a fresh array or object makes the store snapshot unstable - which the store
 * factory turns into a thrown error, i.e. a crash on boot. Deriving here, from a stable slice and
 * memoized at the call site, is the only shape that cannot do that.
 *
 * Nothing here reads the clock either: `now` and `today` are arguments, so a rollover at midnight is
 * the caller's ticking clock rather than a value frozen at first render.
 */

/** How far a store has got with loading what a zone reads. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A pull request that needs my action, with the reason it does. */
export interface ActionPr {
  pr: PullRequest
  reason: string | null
}

/** A task whose deadline has arrived, and whether it has already passed. */
export interface DeadlineTodo {
  task: TodoTask
  overdue: boolean
}

/**
 * The pull requests waiting on me, oldest first - the longest-blocked review is the one costing
 * someone else the most time, so it is the most urgent.
 */
export function actionPrs(prs: PullRequest[]): ActionPr[] {
  return prs
    .filter((pr) => boardColumn(pr) === 'action')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((pr) => ({ pr, reason: boardReason(pr) }))
}

/**
 * The open tasks whose deadline has arrived: overdue first, then due today, each group by due day.
 * Late work outranks work that is merely due, and the two groups are disjoint because today is due
 * but not yet overdue.
 */
export function deadlineTodos(open: TodoTask[], today: string): DeadlineTodo[] {
  const due: { task: TodoTask; overdue: boolean; dueDay: string }[] = []
  for (const task of open) {
    const dueDay = task.dueDay
    if (dueDay === null || task.doneAt !== null) continue
    const overdue = isOverdue(dueDay, today)
    if (!overdue && !isDueToday(dueDay, today)) continue
    due.push({ task, overdue, dueDay })
  }
  due.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueDay.localeCompare(b.dueDay))
  return due.map(({ task, overdue }) => ({ task, overdue }))
}

/**
 * What zone 3 can honestly say about today's worklog.
 *
 * `logged` is the only variant carrying a figure, and every other variant exists because a figure
 * would be a lie there. `0m` is a claim - a day with nothing on it yet - and the reader cannot tell
 * that claim apart from a week that never arrived, so a worklog that does not know says so instead.
 */
export type TimeToday =
  | { kind: 'weekend' }
  | { kind: 'otherWeek' }
  | { kind: 'failed' }
  | { kind: 'loading' }
  | { kind: 'logged'; loggedMs: number }

/**
 * How much time is logged against today, or the reason there is no figure to give.
 *
 * The weekend is stated first because it holds whatever the worklog did: the board excludes
 * Saturday and Sunday by design, so no figure is the right answer either way. Then the week that is
 * loaded has to be the one `now` falls in - the store holds exactly one - and the read has to have
 * finished. Only a week that arrived can be summed, and only then is `0m` a real answer.
 */
export function timeToday(
  entries: TimeEntry[],
  weekStart: string,
  status: LoadStatus,
  now: number
): TimeToday {
  if (isWeekend(now)) return { kind: 'weekend' }
  if (weekStart !== weekStartOf(now)) return { kind: 'otherWeek' }
  if (status === 'error') return { kind: 'failed' }
  if (status !== 'ready') return { kind: 'loading' }
  const today = dayKeyOf(now)
  return {
    kind: 'logged',
    loggedMs: entries.reduce((sum, e) => (e.day === today ? sum + e.durationMs : sum), 0)
  }
}

/**
 * Whether `now` falls on a day the weekday board does not track. Saturday and Sunday are excluded
 * from the worklog by design, so those days are stated as such instead of reported as `0m` - which
 * would read as a day of work missing rather than a day off.
 */
export function isWeekend(now: number): boolean {
  const day = new Date(now).getDay()
  return day === 0 || day === 6
}
