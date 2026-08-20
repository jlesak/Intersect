import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { TodoTask } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { launchFromTodoTask } from '@renderer/features/workItems'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconCalendar, IconPencil, IconPlay, IconTrash } from '@renderer/shared/ui/icons'
import { copyTodoTask } from '../clipboard'
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
 * How long an arriving task stays marked. Long enough to find the row after the section switch,
 * short enough that the mark cannot be mistaken for a persistent selection.
 */
const FOCUS_MARK_MS = 2500

/**
 * Getting a task out of the app as text. The one thing a TODO row offers that has no button of
 * its own, which is why both the pointer menu and the action bar's overflow carry it.
 */
const copyEntry = (task: TodoTask): MenuEntry => ({
  label: 'Copy task',
  onClick: () => void copyTodoTask(task, dayKeyOf(Date.now()))
})

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
  const pendingFocusId = useTodoStore((s) => s.pendingFocusId)

  const [text, setText] = useState('')
  const [dueDay, setDueDay] = useState('')
  const [showDate, setShowDate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [reorderStatus, setReorderStatus] = useState('')
  const [markedId, setMarkedId] = useState<string | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const rowsRef = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    void useTodoStore.getState().load()
  }, [])

  // Land the arrival another surface asked for: bring the row into view and mark it. The request is
  // spent the moment it is honoured, so returning here later does not replay it.
  useEffect(() => {
    if (pendingFocusId === null) return
    useTodoStore.getState().clearFocus()
    setMarkedId(pendingFocusId)
    rowsRef.current.get(pendingFocusId)?.scrollIntoView({ block: 'center' })
  }, [pendingFocusId])

  useEffect(() => {
    if (markedId === null) return
    const timer = setTimeout(() => setMarkedId(null), FOCUS_MARK_MS)
    return () => clearTimeout(timer)
  }, [markedId])

  useEffect(() => {
    if (armedId === null) return
    const disarm = (): void => setArmedId(null)
    window.addEventListener('mouseup', disarm)
    return () => window.removeEventListener('mouseup', disarm)
  }, [armedId])

  /** Drop a task from the renderer-only marks, for a row that is leaving the open list. */
  function forget(id: string): void {
    setSelectedId((current) => (current === id ? null : current))
  }

  function openEditor(id: string): void {
    // The editor is where the row is worked on, so pointing at it is spent.
    setSelectedId(null)
    setEditingId(id)
  }

  function removeTask(id: string): void {
    forget(id)
    void useTodoStore.getState().remove(id)
  }

  /**
   * What a right-click on a task raises: everything the row can do, at the pointer, without
   * aiming at a 12px icon, plus the copy the row itself has no path to. A done task keeps only
   * what still applies, matching the two buttons its own row shows.
   */
  function menuEntriesFor(task: TodoTask, done: boolean): MenuEntry[] {
    const remove: MenuEntry = {
      label: 'Delete',
      icon: <IconTrash />,
      danger: true,
      onClick: () => removeTask(task.id)
    }
    if (done) return [copyEntry(task), { separator: true }, remove]
    return [
      { label: 'Start session', icon: <IconPlay />, onClick: () => launchFromTodoTask(task) },
      { separator: true },
      copyEntry(task),
      { separator: true },
      { label: 'Edit', icon: <IconPencil />, onClick: () => openEditor(task.id) },
      remove
    ]
  }

  const menuTask = menu === null ? undefined : [...open, ...done].find((t) => t.id === menu.id)

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
                selected={selectedId === task.id}
                focused={markedId === task.id}
                rowRef={(el) => {
                  if (el) rowsRef.current.set(task.id, el)
                  else rowsRef.current.delete(task.id)
                }}
                onToggle={() => {
                  forget(task.id)
                  void useTodoStore.getState().toggleDone(task.id, true)
                }}
                onDelete={() => removeTask(task.id)}
                onSelect={() => setSelectedId(task.id)}
                onStartEdit={() => openEditor(task.id)}
                onContextMenu={(x, y) => {
                  // The menu addresses one task, so the row it was raised on says which.
                  setSelectedId(task.id)
                  setMenu({ x, y, id: task.id })
                }}
                overflow={[copyEntry(task)]}
                onCancelEdit={() => setEditingId(null)}
                onSave={(patch) => {
                  setEditingId(null)
                  void useTodoStore.getState().update(task.id, patch)
                }}
                onStartSession={() => launchFromTodoTask(task)}
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
                  onDelete={() => removeTask(task.id)}
                  onContextMenu={(x, y) => setMenu({ x, y, id: task.id })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {menu && menuTask && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntriesFor(menuTask, menuTask.doneAt !== null)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
