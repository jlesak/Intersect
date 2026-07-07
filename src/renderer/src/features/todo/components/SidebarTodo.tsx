import { useTodoStore } from '../store'

/**
 * The sidebar rail for the TODO section. The list itself lives in the section's mainComponent,
 * so the rail stays a light open-task count plus a hint.
 */
export function SidebarTodo() {
  const count = useTodoStore((s) => s.open.length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">
          {count} open {count === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          A lightweight personal task list for small items that do not need a Jira ticket.
        </p>
      </div>
    </div>
  )
}
