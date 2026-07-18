import { useEffect, useRef, useState, type DragEvent } from 'react'
import { IconCalendar } from '@renderer/shared/ui/icons'
import { useTodoStore } from '../store'
import { TodoItem } from './TodoItem'

/** Move one id to an insertion index, accounting for the removal shift. */
function moveId(ids: string[], id: string, insertionIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const requestedIndex = from < insertionIndex ? insertionIndex - 1 : insertionIndex
  const to = Math.max(0, Math.min(ids.length - 1, requestedIndex))
  if (from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * The TODO section's main region. Open tasks use persisted manual ordering; pointer and keyboard
 * interactions both submit the complete order through the optimistic store.
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [reorderStatus, setReorderStatus] = useState('')
  const dropIndexRef = useRef<number | null>(null)

  useEffect(() => {
    void useTodoStore.getState().load()
  }, [])

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
      if (shown) setDueDay('')
      return !shown
    })
  }

  function persistOrder(ids: string[], movedId: string): void {
    const position = ids.indexOf(movedId) + 1
    const task = open.find((candidate) => candidate.id === movedId)
    if (position < 1 || !task) return
    setReorderStatus(`Moved ${task.text} to position ${position} of ${ids.length}.`)
    void useTodoStore.getState().reorder(ids)
  }

  function handleKeyboardMove(id: string, delta: -1 | 1): void {
    const ids = open.map((task) => task.id)
    const from = ids.indexOf(id)
    const task = open[from]
    if (!task) return
    const to = from + delta
    if (to < 0 || to >= ids.length) {
      setReorderStatus(`${task.text} is already ${delta < 0 ? 'first' : 'last'}.`)
      return
    }
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, id)
    persistOrder(next, id)
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
    const current = open.map((task) => task.id)
    const next = moveId(current, id, target)
    if (next === current) return
    persistOrder(next, id)
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

        <div className="ix-todo__reorder-status" role="status" aria-live="polite">
          {reorderStatus}
        </div>

        {status === 'ready' && open.length === 0 ? (
          <div className="ix-todo__empty">No tasks yet - add one above.</div>
        ) : (
          <div className="ix-todo__list" role="list" aria-label="Open tasks">
            {open.map((task, index) => (
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
                drag={{
                  position: index + 1,
                  total: open.length,
                  dragging: dragId === task.id,
                  draggable: armedId === task.id,
                  onHandleMouseDown: () => setArmedId(task.id),
                  onKeyboardMove: (delta) => handleKeyboardMove(task.id, delta),
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
            <div className="ix-todo__list" role="list" aria-label="Done tasks">
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
