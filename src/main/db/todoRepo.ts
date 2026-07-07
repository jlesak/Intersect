import type { DatabaseSync } from 'node:sqlite'
import type { TodoTask } from '@common/domain'
import type { RepoDeps } from './deps'

interface TodoRow {
  id: string
  text: string
  due_day: string | null
  sort_order: number
  done_at: number | null
  created_at: number
}

function toTask(row: TodoRow): TodoTask {
  return {
    id: row.id,
    text: row.text,
    dueDay: row.due_day,
    sortOrder: row.sort_order,
    doneAt: row.done_at
  }
}

/** The only due-day shape the list ever stores: a local calendar day key. */
const DUE_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface TodoRepo {
  /** Open tasks in manual order. */
  listOpen(): TodoTask[]
  /** Done tasks, most recently completed first. */
  listDone(): TodoTask[]
  /** Create an open task at the end of the list. Text must be non-empty after trimming. */
  create(text: string, dueDay: string | null): TodoTask
  /** Checking stamps the completion time; unchecking appends the task to the end of the open list. */
  setDone(id: string, done: boolean): TodoTask
  /** Hard delete - a dismissed task has nothing to resurrect from. */
  remove(id: string): void
  reorder(orderedIds: string[]): TodoTask[]
}

export function createTodoRepo(db: DatabaseSync, deps: RepoDeps): TodoRepo {
  const mustGet = (id: string): TodoTask => {
    const row = db.prepare('SELECT * FROM todo_task WHERE id = ?').get(id) as TodoRow | undefined
    if (!row) throw new Error(`Task not found: ${id}`)
    return toTask(row)
  }

  /** The sort order that places a task after every currently open one. */
  const nextOpenOrder = (): number =>
    (
      db
        .prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM todo_task WHERE done_at IS NULL')
        .get() as { n: number }
    ).n

  const listOpen = (): TodoTask[] => {
    const rows = db
      .prepare('SELECT * FROM todo_task WHERE done_at IS NULL ORDER BY sort_order')
      .all() as unknown as TodoRow[]
    return rows.map(toTask)
  }

  return {
    listOpen,

    listDone() {
      const rows = db
        .prepare('SELECT * FROM todo_task WHERE done_at IS NOT NULL ORDER BY done_at DESC')
        .all() as unknown as TodoRow[]
      return rows.map(toTask)
    },

    create(text, dueDay) {
      const trimmed = text.trim()
      if (!trimmed) throw new Error('Task text must not be empty')
      if (dueDay !== null && !DUE_DAY.test(dueDay)) throw new Error(`Invalid due day: ${dueDay}`)
      const id = deps.newId()
      db.prepare(
        'INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at) VALUES (?,?,?,?,?,?)'
      ).run(id, trimmed, dueDay, nextOpenOrder(), null, deps.now())
      return mustGet(id)
    },

    setDone(id, done) {
      mustGet(id)
      if (done) db.prepare('UPDATE todo_task SET done_at = ? WHERE id = ?').run(deps.now(), id)
      else
        db.prepare('UPDATE todo_task SET done_at = NULL, sort_order = ? WHERE id = ?').run(
          nextOpenOrder(),
          id
        )
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM todo_task WHERE id = ?').run(id)
    },

    // Does not open its own transaction; wrap in tx() when composing with other writes.
    reorder(orderedIds) {
      const update = db.prepare('UPDATE todo_task SET sort_order = ? WHERE id = ? AND done_at IS NULL')
      orderedIds.forEach((id, index) => update.run(index, id))
      return listOpen()
    }
  }
}
