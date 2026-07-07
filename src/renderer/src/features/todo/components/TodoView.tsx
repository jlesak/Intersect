import { useEffect, useRef, useState, type DragEvent } from 'react'
import { IconCalendar } from '@renderer/shared/ui/icons'
import { useTodoStore } from '../store'
import { TodoItem } from './TodoItem'

/**
 * The TODO section's main region: head (title + Done drawer toggle), the add row, the open list
 * with drag-and-drop reordering, and the collapsed-by-default Done drawer. All persistence goes
 * through the store; the only local state is the add form and the in-flight drag.
 */
export function TodoView() {
  const open = useTodoStore((s) => s.open)
  const done = useTodoStore((s) => s.done)
  const status = useTodoStore((s) => s.status)
  const error = useTodoStore((s) => s.error)
  const showDone = useTodoStore((s) => s.showDone)

  const [text, setText] = useState('')
  const [dueDay, setDueDay] = useState('')
  const [showDate, setShowDate] = useState(false)

  // Hand-rolled HTML5 drag and drop over the open list. The handle's mousedown arms its row
  // (making it draggable), dragover over any row records the insertion index from the pointer's
  // half of the row, and drop commits the whole new order in one reorder call.
  const [dragId, setDragId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const dropIndexRef = useRef<number | null>(null)

  useEffect(() => {
    void useTodoStore.getState().load()
  }, [])

  // A grip press that never becomes a drag would otherwise leave its row draggable forever;
  // dragstart has already fired by the time a real drag's mouseup arrives, so this is safe.
  useEffect(() => {
    if (armedId === null) return
    const disarm = (): void => setArmedId(null)
    window.addEventListener('mouseup', disarm)
    return () => window.removeEventListener('mouseup', disarm)
  }, [armedId])

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed) return
    void useTodoStore.getState().add(trimmed, dueDay || null)
    setText('')
    setDueDay('')
    setShowDate(false)
  }

  function toggleDateInput(): void {
    setShowDate((shown) => {
      // Hiding the input also drops a picked date, so no invisible due day rides along on add.
      if (shown) setDueDay('')
      return !shown
    })
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, index: number): void {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    dropIndexRef.current = e.clientY < rect.top + rect.height / 2 ? index : index + 1
  }

  function handleDragEnd(): void {
    setDragId(null)
    setArmedId(null)
    dropIndexRef.current = null
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    const id = dragId
    const target = dropIndexRef.current
    handleDragEnd()
    if (!id || target === null) return
    const ids = open.map((t) => t.id)
    const from = ids.indexOf(id)
    if (from < 0) return
    // Removing the dragged row first shifts every later index left by one.
    const to = from < target ? target - 1 : target
    if (to === from) return
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    void useTodoStore.getState().reorder(ids)
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
            {open.map((task, index) => (
              <TodoItem
                key={task.id}
                task={task}
                done={false}
                onToggle={() => void useTodoStore.getState().toggleDone(task.id, true)}
                onDelete={() => void useTodoStore.getState().remove(task.id)}
                drag={{
                  dragging: dragId === task.id,
                  draggable: armedId === task.id,
                  onHandleMouseDown: () => setArmedId(task.id),
                  onDragStart: (e) => handleDragStart(e, task.id),
                  onDragOver: (e) => handleDragOver(e, index),
                  onDrop: handleDrop,
                  onDragEnd: handleDragEnd
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
