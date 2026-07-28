import { formatRelativeTime } from '@renderer/features/myWork'
import { formatDueDay, useTodoStore } from '@renderer/features/todo'
import { useDashboardNavStore } from '../store'
import type { ActionPr, DeadlineTodo } from '../zones'

/**
 * Zone 1 - everything that is actually waiting on the user, in two labelled subgroups.
 *
 * The groups are never merged into one list: a pull request's age and a task's due day are not
 * comparable quantities, so a single sort would have to invent an exchange rate between them and
 * would reshuffle unpredictably as either source changed.
 */
export function ZoneNeedsAction({
  prs,
  deadlines,
  today,
  now
}: {
  prs: ActionPr[]
  deadlines: DeadlineTodo[]
  today: string
  now: number
}) {
  return (
    <section className="ix-dash-zone ix-dash-zone--wide">
      <div className="ix-dash-zone__head">
        <span className="ix-eyebrow ix-dash-zone__title">Needs action</span>
        <span className="ix-dash-zone__count">{prs.length + deadlines.length}</span>
      </div>

      <div className="ix-dash-group">
        <div className="ix-dash-group__head">
          <span className="ix-dash-group__label">Pull requests</span>
          <span className="ix-dash-group__count">{prs.length}</span>
        </div>
        {prs.length === 0 ? (
          <div className="ix-dash-group__empty">No pull request is waiting on you.</div>
        ) : (
          prs.map(({ pr, reason }) => (
            <button
              key={`${pr.repositoryId}:${pr.prId}`}
              type="button"
              className="ix-dash-row"
              title={pr.title}
              onClick={() => useDashboardNavStore.getState().openPr(pr.repositoryId, pr.prId)}
            >
              <span className="ix-dash-row__main">
                <span className="ix-dash-row__title">{pr.title}</span>
                <span className="ix-dash-row__sub">
                  {pr.repositoryName} · #{pr.prId}
                  {reason !== null && ` · ${reason}`}
                </span>
              </span>
              <span className="ix-dash-row__age">{formatRelativeTime(pr.createdAt, now)}</span>
            </button>
          ))
        )}
      </div>

      <div className="ix-dash-group">
        <div className="ix-dash-group__head">
          <span className="ix-dash-group__label">Deadlines</span>
          <span className="ix-dash-group__count">{deadlines.length}</span>
        </div>
        {deadlines.length === 0 ? (
          <div className="ix-dash-group__empty">Nothing is due today.</div>
        ) : (
          deadlines.map(({ task, overdue }) => (
            <button
              key={task.id}
              type="button"
              className="ix-dash-row ix-dash-row--todo"
              title={task.text}
              onClick={() => useTodoStore.getState().focusTask(task.id)}
            >
              <span className="ix-dash-row__main">
                <span className="ix-dash-row__title">{task.text}</span>
                {task.description !== '' && (
                  <span className="ix-dash-row__sub">{task.description}</span>
                )}
              </span>
              {task.dueDay !== null && (
                <span
                  className={`ix-dash-row__due${overdue ? ' ix-dash-row__due--overdue' : ''}`}
                >
                  {formatDueDay(task.dueDay, today)}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </section>
  )
}
