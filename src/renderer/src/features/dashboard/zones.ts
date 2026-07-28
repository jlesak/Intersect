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
 * How much time is logged against today, or null when the loaded week is not the one `now` falls in.
 *
 * The time-tracking store holds exactly one week at a time. Answering 0 for a week the user
 * navigated away to would be a wrong figure where the truthful answer is that today's is not loaded,
 * and a worklog surface that reports wrong numbers is worse than one that admits a gap.
 */
export function loggedToday(entries: TimeEntry[], weekStart: string, now: number): number | null {
  if (weekStart !== weekStartOf(now)) return null
  const today = dayKeyOf(now)
  return entries.reduce((sum, e) => (e.day === today ? sum + e.durationMs : sum), 0)
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
