import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { TodoTask, TodoTaskPatch } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { IconCalendar, IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { formatDueDay, isOverdue } from '../due'

export interface TodoItemDrag {
  position: number
  total: number
  dragging: boolean
  draggable: boolean
  onHandleMouseDown(): void
  onKeyboardMove(delta: -1 | 1): void
  onDragStart(e: DragEvent<HTMLDivElement>): void
  onDragOver(e: DragEvent<HTMLDivElement>): void
  onDrop(e: DragEvent<HTMLDivElement>): void
  onDragEnd(): void
}

/** One TODO row, including inline editing and accessible manual-order controls for open tasks. */
export function TodoItem({
  task,
  done,
  editing,
  onToggle,
  onDelete,
  onStartEdit,
  onCancelEdit,
  onSave,
  onContextMenu,
  drag
}: {
  task: TodoTask
  done: boolean
  editing?: boolean
  onToggle(): void
  onDelete(): void
  onStartEdit?(): void
  onCancelEdit?(): void
  onSave?(patch: TodoTaskPatch): void
  /** Lets the embedding list attach a per-row menu (e.g. session launch) at the pointer. */
  onContextMenu?(x: number, y: number): void
  drag?: TodoItemDrag
}) {
  const today = dayKeyOf(Date.now())
  const overdue = !done && task.dueDay !== null && isOverdue(task.dueDay, today)

  const [draftText, setDraftText] = useState(task.text)
  const [draftDescription, setDraftDescription] = useState(task.description)
  const [draftDueDay, setDraftDueDay] = useState(task.dueDay ?? '')

  useEffect(() => {
    if (!editing) return
    setDraftText(task.text)
    setDraftDescription(task.description)
    setDraftDueDay(task.dueDay ?? '')
  }, [editing, task.text, task.description, task.dueDay])

  function save(): void {
    const trimmed = draftText.trim()
    if (!trimmed) return
    onSave?.({ text: trimmed, description: draftDescription, dueDay: draftDueDay || null })
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const isButton = (e.target as HTMLElement).tagName === 'BUTTON'
    if (e.key === 'Enter' && !isButton) save()
    if (e.key === 'Escape') onCancelEdit?.()
  }

  if (editing) {
    return (
      <div className="ix-todo-item ix-todo-item--editing" role="listitem" onKeyDown={onEditorKeyDown}>
        <span className="ix-todo-item__drag-spacer" aria-hidden />
        <span className="ix-todo-item__check-spacer" />
        <span className="ix-todo-item__editor">
          <input
            className="ix-input"
            autoFocus
            placeholder="Task"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
          />
          <input
            className="ix-input"
            placeholder="Description"
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
          />
          <span className="ix-todo-item__editor-row">
            <input
              type="date"
              className="ix-input ix-todo__date"
              value={draftDueDay}
              onChange={(e) => setDraftDueDay(e.target.value)}
            />
            <span className="ix-todo-item__editor-actions">
              <button type="button" className="ix-btn ix-btn--ghost" onClick={onCancelEdit}>
                Cancel
              </button>
              <button type="button" className="ix-btn ix-btn--primary" onClick={save}>
                Save
              </button>
            </span>
          </span>
        </span>
      </div>
    )
  }

  return (
    <div
      className={`ix-todo-item${done ? ' ix-todo-item--done' : ''}${
        drag?.dragging ? ' ix-todo-item--dragging' : ''
      }`}
      role="listitem"
      draggable={drag?.draggable ?? false}
      onClick={!done ? onStartEdit : undefined}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              onContextMenu(e.clientX, e.clientY)
            }
          : undefined
      }
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      {drag ? (
        <button
          type="button"
          className="ix-todo-item__drag"
          aria-label={`Move ${task.text}, position ${drag.position} of ${drag.total}. Use Up and Down arrow keys to reorder.`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title="Drag to reorder; use Up/Down arrow keys"
          onMouseDown={(e) => {
            e.stopPropagation()
            drag.onHandleMouseDown()
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            e.stopPropagation()
            drag.onKeyboardMove(e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
            <circle cx="2" cy="2" r="1.3" />
            <circle cx="8" cy="2" r="1.3" />
            <circle cx="2" cy="7" r="1.3" />
            <circle cx="8" cy="7" r="1.3" />
            <circle cx="2" cy="12" r="1.3" />
            <circle cx="8" cy="12" r="1.3" />
          </svg>
        </button>
      ) : (
        <span className="ix-todo-item__drag-spacer" aria-hidden />
      )}
      <button
        type="button"
        className="ix-todo-item__check"
        title={done ? 'Mark as not done' : 'Mark as done'}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {done ? '✓' : ''}
      </button>
      <span className="ix-todo-item__body">
        <span className="ix-todo-item__text">{task.text}</span>
        {task.description !== '' && (
          <span className="ix-todo-item__description">{task.description}</span>
        )}
        {task.dueDay !== null && (
          <span className="ix-todo-item__meta">
            <span className={`ix-todo-item__due${overdue ? ' ix-todo-item__due--overdue' : ''}`}>
              <IconCalendar width={10} height={10} strokeWidth={1.8} />
              {formatDueDay(task.dueDay, today)}
            </span>
          </span>
        )}
      </span>
      <span className="ix-todo-item__actions">
        {!done && (
          <button
            type="button"
            className="ix-iconbtn"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit?.()
            }}
          >
            <IconPencil width={12} height={12} />
          </button>
        )}
        <button
          type="button"
          className="ix-iconbtn"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <IconTrash width={12} height={12} />
        </button>
      </span>
    </div>
  )
}
