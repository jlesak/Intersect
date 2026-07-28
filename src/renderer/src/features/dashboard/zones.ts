import type { AdoFallback, AdoSettings, PullRequest, TimeEntry, TodoTask } from '@common/domain'
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

/**
 * Whether a source has a connection at all. `unknown` is its own answer rather than a pessimistic
 * `missing`: the settings that decide this are read at boot like everything else, and claiming a
 * source is not set up while that read is still in flight would be the same wrong guess in the
 * other direction.
 */
export type SourceSetup = 'configured' | 'missing' | 'unknown'

/**
 * Whether Azure DevOps has enough of a connection for anything to load, mirroring what the core
 * requires to spawn its client: an organisation URL and a token. Each may come from what the user
 * saved in the app or from the `~/.claude.json` / environment fallback, and a blank saved field
 * defers to that fallback rather than overriding it.
 */
export function adoSetup(
  status: LoadStatus,
  ado: AdoSettings,
  fallback: AdoFallback
): SourceSetup {
  if (status !== 'ready') return 'unknown'
  const orgUrl = ado.orgUrl.trim() || fallback.orgUrl.trim()
  const hasPat = ado.pat.trim() !== '' || fallback.hasPat
  return orgUrl !== '' && hasPat ? 'configured' : 'missing'
}

/**
 * Why a zone has nothing to list.
 *
 * The four are never collapsed into one line of prose. "Nothing is waiting on you", "we could not
 * find out what is waiting on you" and "you never connected the thing that would know" are three
 * different answers, and a surface whose whole purpose is to say what needs the user may only give
 * the reassuring one when it is true.
 */
export type EmptyState = 'clear' | 'loading' | 'failed' | 'unconfigured'

/**
 * What an empty list means, given how the read that produced it went and whether the source it read
 * from was ever connected.
 *
 * A missing connection outranks the read, because a read of an empty local cache succeeds perfectly
 * well when there is nothing behind it to fill the cache - that success is exactly what makes an
 * unconfigured source look like an all-clear.
 */
export function emptyState(status: LoadStatus, setup: SourceSetup = 'configured'): EmptyState {
  if (setup === 'missing') return 'unconfigured'
  if (status === 'error') return 'failed'
  return status === 'ready' && setup === 'configured' ? 'clear' : 'loading'
}

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
