import { formatRelativeTime } from '@renderer/features/myWork'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { formatDueDay, useTodoStore } from '@renderer/features/todo'
import { useDashboardNavStore } from '../store'
import type { ActionPr, DeadlineTodo, EmptyState } from '../zones'
import { ZoneNote, type NoteAction } from './ZoneNote'

/** What an empty pull-request subgroup means, per how the read that produced it went. */
const PR_NOTE: Record<EmptyState, string> = {
  clear: 'No pull request is waiting on you.',
  loading: 'Reading the pull request cache…',
  failed: 'The pull request cache could not be read.'
}

/** The same three answers for the deadlines subgroup. */
const DEADLINE_NOTE: Record<EmptyState, string> = {
  clear: 'Nothing is due today.',
  loading: 'Reading the task list…',
  failed: 'The task list could not be read.'
}

/**
 * The way out of a failed read: ask for it again. The other two states have nothing to press - one
 * is the good news, and the other is a read already in flight.
 */
function retry(state: EmptyState, run: () => void): NoteAction | undefined {
  return state === 'failed' ? { label: 'Try again', onClick: run } : undefined
}

/**
 * Zone 1 - everything that is actually waiting on the user, in two labelled subgroups.
 *
 * The groups are never merged into one list: a pull request's age and a task's due day are not
 * comparable quantities, so a single sort would have to invent an exchange rate between them and
 * would reshuffle unpredictably as either source changed.
 *
 * Each subgroup carries its own source's load state, because an empty list on its own says nothing
 * about whether the source was read. Reporting all-clear for a read that failed would be the exact
 * inverse of what this zone is for, and it would be the last thing the user ever heard about it.
 */
export function ZoneNeedsAction({
  prs,
  prState,
  deadlines,
  deadlineState,
  today,
  now
}: {
  prs: ActionPr[]
  prState: EmptyState
  deadlines: DeadlineTodo[]
  deadlineState: EmptyState
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
          <ZoneNote
            className="ix-dash-group__empty"
            note={PR_NOTE[prState]}
            action={retry(prState, () => void usePrInboxStore.getState().hydrate())}
          />
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
          <ZoneNote
            className="ix-dash-group__empty"
            note={DEADLINE_NOTE[deadlineState]}
            action={retry(deadlineState, () => void useTodoStore.getState().load())}
          />
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
