import { useEffect, useState } from 'react'
import type { TodoPriority } from '@common/domain'
import { IconCalendar } from '@renderer/shared/ui/icons'
import { useTodoStore } from '../store'
import { PriorityPicker, TodoItem } from './TodoItem'

/**
 * The TODO section's main region: head (title + Done drawer toggle), the add row, the open list
 * (ordered by priority then due date - no manual reordering), and the collapsed-by-default Done
 * drawer. All persistence goes through the store; local state is only the add form and which row
 * (if any) is currently expanded into its inline editor.
 */
export function TodoView() {
  const open = useTodoStore((s) => s.open)
  const done = useTodoStore((s) => s.done)
  const status = useTodoStore((s) => s.status)
  const error = useTodoStore((s) => s.error)
  const showDone = useTodoStore((s) => s.showDone)

  const [text, setText] = useState('')
  const [dueDay, setDueDay] = useState('')
  const [priority, setPriority] = useState<TodoPriority>(4)
  const [showDate, setShowDate] = useState(false)

  // Only one row can be expanded into its inline editor at a time.
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    void useTodoStore.getState().load()
  }, [])

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed) return
    void useTodoStore.getState().add(trimmed, dueDay || null, priority)
    setText('')
    setDueDay('')
    setPriority(4)
    setShowDate(false)
  }

  function toggleDateInput(): void {
    setShowDate((shown) => {
      // Hiding the input also drops a picked date, so no invisible due day rides along on add.
      if (shown) setDueDay('')
      return !shown
    })
  }

  return (
    <div className="ix-main">
      <div className="ix-todo">
        <div className="ix-todo__head">
          <span className="ix-todo__title">TODO</span>
          <button
            type="button"
            className="ix-todo__done-link"
            onClick={() => useTodoStore.getState().toggleShowDone()}
          >
            {showDone ? 'Hide done' : `Show done (${done.length})`}
          </button>
        </div>

        <div className="ix-todo__add">
          <input
            className="ix-input"
            placeholder="Add a task… (Enter)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          {showDate && (
            <input
              type="date"
              className="ix-input ix-todo__date"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
            />
          )}
          <PriorityPicker value={priority} onChange={setPriority} />
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            title="Add due date"
            onClick={toggleDateInput}
          >
            <IconCalendar />
          </button>
        </div>

        {status === 'error' && (
          <div className="ix-todo__error">Could not load tasks{error ? `: ${error}` : ''}</div>
        )}

        {status === 'ready' && open.length === 0 ? (
          <div className="ix-todo__empty">No tasks yet - add one above.</div>
        ) : (
          <div className="ix-todo__list">
            {open.map((task) => (
              <TodoItem
                key={task.id}
                task={task}
                done={false}
                editing={editingId === task.id}
                onToggle={() => void useTodoStore.getState().toggleDone(task.id, true)}
                onDelete={() => void useTodoStore.getState().remove(task.id)}
                onStartEdit={() => setEditingId(task.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(patch) => {
                  setEditingId(null)
                  void useTodoStore.getState().update(task.id, patch)
                }}
              />
            ))}
          </div>
        )}

        {showDone && (
          <div className="ix-todo__done-drawer">
            <div className="ix-todo__done-head">
              <span className="ix-todo__done-title">Done</span>
              <span className="ix-todo__done-count">{done.length}</span>
            </div>
            <div className="ix-todo__list">
              {done.map((task) => (
                <TodoItem
                  key={task.id}
                  task={task}
                  done
                  onToggle={() => void useTodoStore.getState().toggleDone(task.id, false)}
                  onDelete={() => void useTodoStore.getState().remove(task.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
