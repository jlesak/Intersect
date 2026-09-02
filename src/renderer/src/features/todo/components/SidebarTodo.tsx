import { dayKeyOf } from '@common/week'
import { useNow } from '@renderer/shared/ui/useNow'
import { isDueToday, isOverdue } from '../due'
import { useTodoStore } from '../store'

/**
 * How often the rail re-reads the clock. What is late and what is due changes when the day does,
 * so a coarse tick is all it takes to roll the counts over at midnight instead of leaving them
 * frozen at whatever day the section was first opened on.
 */
const DAY_TICK_MS = 60_000

/**
 * The sidebar rail for the TODO section. The list itself lives in the section's mainComponent, so
 * the rail stays a count of what is open plus what the deadlines say: how much is already late,
 * and how much is due before the day is out. Each line is dropped at zero, so a list with nothing
 * pressing stays quiet.
 */
export function SidebarTodo() {
  const today = dayKeyOf(useNow(DAY_TICK_MS))
  const count = useTodoStore((s) => s.open.length)
  // Both answer with a count. A selector that allocates internally but returns a primitive is a
  // stable snapshot, so neither needs useShallow nor a derivation held in the store.
  const overdue = useTodoStore(
    (s) => s.open.filter((t) => t.dueDay !== null && isOverdue(t.dueDay, today)).length
  )
  const dueToday = useTodoStore(
    (s) => s.open.filter((t) => t.dueDay !== null && isDueToday(t.dueDay, today)).length
  )

  return (
    <div className="ix-sidebar__body">
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">
          {count} open {count === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      {(overdue > 0 || dueToday > 0) && (
        <div className="ix-todo-rail__due">
          {overdue > 0 && (
            <span className="ix-todo-rail__due-line ix-todo-rail__due-line--overdue">
              {overdue} overdue
            </span>
          )}
          {dueToday > 0 && <span className="ix-todo-rail__due-line">{dueToday} due today</span>}
        </div>
      )}
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          A lightweight personal task list for small items that do not need a Jira ticket.
        </p>
      </div>
    </div>
  )
}
