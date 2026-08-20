import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { TodoTask, TodoTaskPatch } from '@common/domain'
import { dayKeyOf } from '@common/week'
import type { MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconCalendar, IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { RowActions } from '@renderer/shared/ui/RowActions'
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

/**
 * One TODO row, including inline editing and accessible manual-order controls for open tasks.
 *
 * A plain click only points at a task: it selects the row and takes keyboard focus. Editing waits
 * for a gesture the user has to mean - the pencil, a double-click, or Enter on the focused row -
 * so pointing at a row, or starting a drag from it, can never put it into the editor.
 *
 * An open row is a tab stop, and the bar it reveals carries the session launch, so the row can be
 * worked entirely from the keyboard.
 */
export function TodoItem({
  task,
  done,
  editing,
  selected,
  onToggle,
  onDelete,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onSave,
  onStartSession,
  onContextMenu,
  overflow,
  focused,
  rowRef,
  drag
}: {
  task: TodoTask
  done: boolean
  editing?: boolean
  /** Marks the row the user last pointed at. Persists until another row takes the selection. */
  selected?: boolean
  onToggle(): void
  onDelete(): void
  /** The row was pointed at. Given for open tasks; a done one is a record rather than a target. */
  onSelect?(): void
  onStartEdit?(): void
  onCancelEdit?(): void
  onSave?(patch: TodoTaskPatch): void
  /** Starts a Claude session on this task. Given for open tasks; a done one has no work left. */
  onStartSession?(): void
  /** Lets the embedding list attach a per-row menu at the pointer. */
  onContextMenu?(x: number, y: number): void
  /** What the action bar hides behind its overflow: what the bar does not already show. */
  overflow?: MenuEntry[]
  /** Marks the row the user was sent here to look at, so it stands out on arrival. */
  focused?: boolean
  /** Lets the embedding list hold on to the row element so it can scroll it into view. */
  rowRef?(el: HTMLDivElement | null): void
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
      ref={rowRef}
      className={`ix-todo-item${done ? ' ix-todo-item--done' : ''}${
        drag?.dragging ? ' ix-todo-item--dragging' : ''
      }${focused ? ' ix-todo-item--focused' : ''}${selected ? ' ix-todo-item--selected' : ''}`}
      role="listitem"
      tabIndex={done ? undefined : 0}
      draggable={drag?.draggable ?? false}
      onClick={
        done
          ? undefined
          : (e) => {
              // Taking focus with the selection lets the keyboard carry on from the row the mouse
              // just pointed at.
              e.currentTarget.focus()
              onSelect?.()
            }
      }
      onDoubleClick={
        done
          ? undefined
          : (e) => {
              // A double-press on one of the row's own buttons belongs to that button, and one
              // in a menu the row raised elsewhere in the document is not the row's at all.
              const target = e.target as HTMLElement
              if (!e.currentTarget.contains(target) || target.closest('button') !== null) return
              onStartEdit?.()
            }
      }
      onKeyDown={
        done
          ? undefined
          : (e) => {
              // A press on one of the row's own buttons belongs to that button.
              if (e.target !== e.currentTarget) return
              // A task lives only in this list, so there is nothing for Cmd+Enter to open.
              if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return
              e.preventDefault()
              onStartEdit?.()
            }
      }
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
        {onStartSession && !done && (
          <RowActions
            primary={{ label: 'Start session', onClick: onStartSession }}
            overflow={overflow}
          />
        )}
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
