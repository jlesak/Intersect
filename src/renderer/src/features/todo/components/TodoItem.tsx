import { useEffect, useState, type KeyboardEvent } from 'react'
import type { TodoPriority, TodoTask, TodoTaskPatch } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { IconCalendar, IconFlag, IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { formatDueDay, isOverdue } from '../due'

const PRIORITIES: TodoPriority[] = [1, 2, 3, 4]

/** Priority 4 means "no priority" and gets the neutral look everywhere - no class, no label. */
const PRIORITY_CLASS: Record<TodoPriority, string> = { 1: '--p1', 2: '--p2', 3: '--p3', 4: '' }

/**
 * The P1-P4 chip picker shared by the add row and the inline editor. Each chip is a small flag
 * tinted by its own priority color, regardless of which priority is currently selected.
 */
export function PriorityPicker({
  value,
  onChange
}: {
  value: TodoPriority
  onChange(priority: TodoPriority): void
}) {
  return (
    <span className="ix-todo-prio-picker">
      {PRIORITIES.map((p) => (
        <button
          key={p}
          type="button"
          className={`ix-todo-prio-picker__chip ix-todo-prio-picker__chip${PRIORITY_CLASS[p]}${
            p === value ? ' ix-todo-prio-picker__chip--selected' : ''
          }`}
          title={`Priority ${p}`}
          onClick={() => onChange(p)}
        >
          <IconFlag width={10} height={10} strokeWidth={1.8} />
        </button>
      ))}
    </span>
  )
}

/**
 * One row of the TODO list. Collapsed, it shows a priority-tinted checkbox, the title, an
 * optional single-line description, and a meta row (due label, priority label for P1-P3). A done
 * row keeps its checkbox filled so unchecking works from the Done drawer, and is never editable.
 * Expanded (open rows only), it becomes an inline editor for every field.
 */
export function TodoItem({
  task,
  done,
  editing,
  onToggle,
  onDelete,
  onStartEdit,
  onCancelEdit,
  onSave
}: {
  task: TodoTask
  done: boolean
  editing?: boolean
  onToggle(): void
  onDelete(): void
  onStartEdit?(): void
  onCancelEdit?(): void
  onSave?(patch: TodoTaskPatch): void
}) {
  const today = dayKeyOf(Date.now())
  const overdue = !done && task.dueDay !== null && isOverdue(task.dueDay, today)

  const [draftText, setDraftText] = useState(task.text)
  const [draftDescription, setDraftDescription] = useState(task.description)
  const [draftDueDay, setDraftDueDay] = useState(task.dueDay ?? '')
  const [draftPriority, setDraftPriority] = useState<TodoPriority>(task.priority)

  // Re-seed the draft from the canonical task every time this row enters edit mode.
  useEffect(() => {
    if (!editing) return
    setDraftText(task.text)
    setDraftDescription(task.description)
    setDraftDueDay(task.dueDay ?? '')
    setDraftPriority(task.priority)
  }, [editing])

  function save(): void {
    const trimmed = draftText.trim()
    if (!trimmed) return
    onSave?.({
      text: trimmed,
      description: draftDescription,
      dueDay: draftDueDay || null,
      priority: draftPriority
    })
  }

  // Handled on the editor container rather than per-field, so Enter/Escape work from any focused
  // control (text fields, the date input, a priority chip) - not just the two text inputs. A
  // button's own click already carries the right meaning for Enter (Cancel must still cancel, a
  // priority chip just selects), so buttons are left to their native activation instead of being
  // forced through save() here; Escape has no such native behavior, so it always cancels.
  function onEditorKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const isButton = (e.target as HTMLElement).tagName === 'BUTTON'
    if (e.key === 'Enter' && !isButton) save()
    if (e.key === 'Escape') onCancelEdit?.()
  }

  if (editing) {
    return (
      <div className="ix-todo-item ix-todo-item--editing" onKeyDown={onEditorKeyDown}>
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
            <PriorityPicker value={draftPriority} onChange={setDraftPriority} />
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
      className={`ix-todo-item${done ? ' ix-todo-item--done' : ''}`}
      onClick={!done ? onStartEdit : undefined}
    >
      <button
        type="button"
        className={`ix-todo-item__check ix-todo-item__check${PRIORITY_CLASS[task.priority]}`}
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
        {(task.dueDay !== null || task.priority < 4) && (
          <span className="ix-todo-item__meta">
            {task.dueDay !== null && (
              <span className={`ix-todo-item__due${overdue ? ' ix-todo-item__due--overdue' : ''}`}>
                <IconCalendar width={10} height={10} strokeWidth={1.8} />
                {formatDueDay(task.dueDay, today)}
              </span>
            )}
            {task.priority < 4 && (
              <span className={`ix-todo-item__prio ix-todo-item__prio${PRIORITY_CLASS[task.priority]}`}>
                P{task.priority}
              </span>
            )}
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
