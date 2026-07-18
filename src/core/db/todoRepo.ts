import type { DatabaseSync } from 'node:sqlite'
import type { TodoPriority, TodoTask, TodoTaskPatch } from '@common/domain'
import type { RepoDeps } from './deps'
import { tx } from './tx'

interface TodoRow {
  id: string
  text: string
  description: string
  due_day: string | null
  priority: number
  sort_order: number
  done_at: number | null
  created_at: number
}

function toTask(row: TodoRow): TodoTask {
  return {
    id: row.id,
    text: row.text,
    description: row.description,
    dueDay: row.due_day,
    priority: row.priority as TodoPriority,
    sortOrder: row.sort_order,
    doneAt: row.done_at
  }
}

/** The only due-day shape the list ever stores: a local calendar day key. */
const DUE_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface TodoRepo {
  /** The task by id (open or done), or undefined once it has been hard-deleted. */
  getById(id: string): TodoTask | undefined
  /** Open tasks in persisted manual order. */
  listOpen(): TodoTask[]
  /** Done tasks, most recently completed first. */
  listDone(): TodoTask[]
  /** Create an open task at the end of the list. Text must be non-empty after trimming. */
  create(text: string, dueDay: string | null): TodoTask
  /** Edit any subset of a task's fields in place. Validates like create. */
  update(id: string, patch: TodoTaskPatch): TodoTask
  /** Checking stamps the completion time; unchecking appends the task to the end of the open list. */
  setDone(id: string, done: boolean): TodoTask
  /** Hard delete - a dismissed task has nothing to resurrect from. */
  remove(id: string): void
  /** Replace the complete open ordering in one transaction. */
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
      .prepare('SELECT * FROM todo_task WHERE done_at IS NULL ORDER BY sort_order, created_at, id')
      .all() as unknown as TodoRow[]
    return rows.map(toTask)
  }

  return {
    getById(id) {
      const row = db.prepare('SELECT * FROM todo_task WHERE id = ?').get(id) as TodoRow | undefined
      return row ? toTask(row) : undefined
    },

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
        `INSERT INTO todo_task (id, text, description, due_day, sort_order, done_at, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(id, trimmed, '', dueDay, nextOpenOrder(), null, deps.now())
      return mustGet(id)
    },

    update(id, patch) {
      mustGet(id)
      const sets: string[] = []
      const params: (string | number | null)[] = []

      if (patch.text !== undefined) {
        const trimmed = patch.text.trim()
        if (!trimmed) throw new Error('Task text must not be empty')
        sets.push('text = ?')
        params.push(trimmed)
      }
      if (patch.description !== undefined) {
        sets.push('description = ?')
        params.push(patch.description)
      }
      if (patch.dueDay !== undefined) {
        if (patch.dueDay !== null && !DUE_DAY.test(patch.dueDay))
          throw new Error(`Invalid due day: ${patch.dueDay}`)
        sets.push('due_day = ?')
        params.push(patch.dueDay)
      }
      if (sets.length > 0) {
        params.push(id)
        db.prepare(`UPDATE todo_task SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      }
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

    reorder(orderedIds) {
      const currentIds = listOpen().map((task) => task.id)
      const uniqueIds = new Set(orderedIds)
      const currentSet = new Set(currentIds)
      const exactSet =
        orderedIds.length === currentIds.length &&
        uniqueIds.size === orderedIds.length &&
        orderedIds.every((id) => currentSet.has(id))
      if (!exactSet) throw new Error('Reorder must contain every open task exactly once')

      return tx(db, () => {
        const update = db.prepare(
          'UPDATE todo_task SET sort_order = ? WHERE id = ? AND done_at IS NULL'
        )
        orderedIds.forEach((id, index) => {
          const result = update.run(index, id)
          if (result.changes !== 1) throw new Error(`Open task not found while reordering: ${id}`)
        })
        return listOpen()
      })
    }
  }
}
