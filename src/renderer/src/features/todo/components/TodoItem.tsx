import type { DragEvent } from 'react'
import type { TodoTask } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { IconCalendar, IconTrash } from '@renderer/shared/ui/icons'
import { formatDueDay, isOverdue } from '../due'

/** Native drag-and-drop wiring an open row receives from the list; Done rows have none. */
export interface TodoItemDrag {
  dragging: boolean
  draggable: boolean
  onHandleMouseDown(): void
  onDragStart(e: DragEvent<HTMLDivElement>): void
  onDragOver(e: DragEvent<HTMLDivElement>): void
  onDrop(e: DragEvent<HTMLDivElement>): void
  onDragEnd(): void
}

/**
 * One row of the TODO list: grip handle (open rows only), checkbox, text with the optional due
 * label, and a hover-revealed delete. A done row keeps its checkbox filled so unchecking works
 * from the Done drawer; its due label never reads as overdue - the task is finished.
 */
export function TodoItem({
  task,
  done,
  onToggle,
  onDelete,
  drag
}: {
  task: TodoTask
  done: boolean
  onToggle(): void
  onDelete(): void
  drag?: TodoItemDrag
}) {
  const today = dayKeyOf(Date.now())
  const overdue = !done && task.dueDay !== null && isOverdue(task.dueDay, today)

  return (
    <div
      className={`ix-todo-item${done ? ' ix-todo-item--done' : ''}${
        drag?.dragging ? ' ix-todo-item--dragging' : ''
      }`}
      draggable={drag?.draggable ?? false}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      <span className="ix-todo-item__drag" onMouseDown={drag?.onHandleMouseDown}>
        {drag && (
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
            <circle cx="2" cy="2" r="1.3" />
            <circle cx="8" cy="2" r="1.3" />
            <circle cx="2" cy="7" r="1.3" />
            <circle cx="8" cy="7" r="1.3" />
            <circle cx="2" cy="12" r="1.3" />
            <circle cx="8" cy="12" r="1.3" />
          </svg>
        )}
      </span>
      <button
        type="button"
        className="ix-todo-item__check"
        title={done ? 'Mark as not done' : 'Mark as done'}
        onClick={onToggle}
      >
        {done ? '✓' : ''}
      </button>
      <span className="ix-todo-item__body">
        <span className="ix-todo-item__text">{task.text}</span>
        {task.dueDay !== null && (
          <span className={`ix-todo-item__due${overdue ? ' ix-todo-item__due--overdue' : ''}`}>
            <IconCalendar width={10} height={10} strokeWidth={1.8} />
            {formatDueDay(task.dueDay, today)}
          </span>
        )}
      </span>
      <span className="ix-todo-item__actions">
        <button type="button" className="ix-iconbtn" title="Delete" onClick={onDelete}>
          <IconTrash width={12} height={12} />
        </button>
      </span>
    </div>
  )
}
