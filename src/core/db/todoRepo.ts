import type { DatabaseSync } from 'node:sqlite'
import type {
  TodoCompletion, TodoCompletionResult, TodoCreateInput, TodoPriority, TodoProject, TodoQuery,
  TodoQueryResult, TodoSavedFilter, TodoTag, TodoTask, TodoTaskPatch
} from '@common/domain'
import { dayKeyOf } from '@common/week'
import { byDue, matchesQuery, nextOccurrence, validateQuery, validateSchedule } from '../todo/rules'
import type { RepoDeps } from './deps'
import { tx } from './tx'

type Row = Record<string, unknown>
const priority = (value: number): TodoPriority => value as TodoPriority
const normalized = (name: string): string => name.trim().normalize('NFKC').toLocaleLowerCase()
const nameOf = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name must not be empty')
  return trimmed
}

export interface TodoRepo {
  getById(id: string): TodoTask | undefined
  listOpen(): TodoTask[]
  listDone(): TodoTask[]
  create(input: TodoCreateInput | string, dueDay?: string | null): TodoTask
  update(id: string, patch: TodoTaskPatch): TodoTask
  setDone(id: string, done: boolean): TodoTask
  complete(id: string, expectedRevision: number): TodoCompletionResult
  history(id: string): TodoCompletion[]
  remove(id: string): void
  reorder(orderedIds: string[], projectId?: string | null): TodoTask[]
  listProjects(): TodoProject[]
  createProject(name: string): TodoProject
  updateProject(id: string, name: string): TodoProject
  removeProject(id: string): void
  listTags(): TodoTag[]
  createTag(name: string): TodoTag
  updateTag(id: string, name: string): TodoTag
  removeTag(id: string): void
  listFilters(): TodoSavedFilter[]
  createFilter(name: string, query: TodoQuery): TodoSavedFilter
  updateFilter(id: string, name: string, query: TodoQuery): TodoSavedFilter
  removeFilter(id: string): void
  query(query: TodoQuery, today: string): TodoQueryResult
}

export function createTodoRepo(db: DatabaseSync, deps: RepoDeps): TodoRepo {
  const tagIds = (id: string): string[] => (db.prepare(
    'SELECT tag_id FROM todo_task_tag WHERE task_id = ? ORDER BY tag_id'
  ).all(id) as { tag_id: string }[]).map((row) => row.tag_id)
  const toTask = (row: Row): TodoTask => ({
    id: row.id as string, text: row.text as string, description: row.description as string,
    dueDay: row.due_day as string | null, dueTime: row.due_time as string | null,
    priority: priority(row.priority as number), size: row.size as TodoTask['size'],
    projectId: row.todo_project_id as string | null, tagIds: tagIds(row.id as string),
    recurrence: row.recurrence_mode ? {
      mode: row.recurrence_mode as 'fixed' | 'after_completion',
      unit: row.recurrence_unit as 'day' | 'week' | 'month' | 'year',
      interval: row.recurrence_interval as number, anchorDay: row.recurrence_anchor_day as string
    } : null,
    revision: row.task_revision as number, sortOrder: row.sort_order as number,
    doneAt: row.done_at as number | null
  })
  const getById = (id: string): TodoTask | undefined => {
    const row = db.prepare('SELECT * FROM todo_task WHERE id = ?').get(id) as Row | undefined
    return row ? toTask(row) : undefined
  }
  const mustGet = (id: string): TodoTask => {
    const task = getById(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }
  const nextOrder = (projectId: string | null): number => (db.prepare(
    'SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM todo_task WHERE done_at IS NULL AND todo_project_id IS ?'
  ).get(projectId) as { n: number }).n
  const listOpen = (): TodoTask[] => (db.prepare(
    'SELECT * FROM todo_task WHERE done_at IS NULL ORDER BY sort_order, created_at, id'
  ).all() as Row[]).map(toTask)
  const listDone = (): TodoTask[] => (db.prepare(
    'SELECT * FROM todo_task WHERE done_at IS NOT NULL ORDER BY done_at DESC'
  ).all() as Row[]).map(toTask)
  const checkProject = (id: string | null): void => {
    if (id !== null && !db.prepare('SELECT id FROM todo_project WHERE id = ?').get(id))
      throw new Error('TODO project not found')
  }
  const checkTags = (ids: string[]): void => {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate TODO tag')
    for (const id of ids) if (!db.prepare('SELECT id FROM todo_tag WHERE id = ?').get(id))
      throw new Error('TODO tag not found')
  }
  const writeTags = (id: string, ids: string[]): void => {
    db.prepare('DELETE FROM todo_task_tag WHERE task_id = ?').run(id)
    const insert = db.prepare('INSERT INTO todo_task_tag(task_id, tag_id) VALUES (?, ?)')
    for (const tagId of ids) insert.run(id, tagId)
  }
  const validateTask = (input: TodoCreateInput): void => {
    if (!input.text.trim()) throw new Error('Task text must not be empty')
    if (input.priority !== undefined && ![1, 2, 3, 4].includes(input.priority))
      throw new Error('Invalid priority')
    if (input.size !== undefined && input.size !== null &&
      !['XS', 'S', 'M', 'L', 'XL'].includes(input.size)) throw new Error('Invalid size')
    validateSchedule(input.dueDay ?? null, input.dueTime ?? null, input.recurrence ?? null)
    checkProject(input.projectId ?? null)
    checkTags(input.tagIds ?? [])
  }
  const missing = (query: TodoQuery): ('project' | 'tag')[] => {
    const result: ('project' | 'tag')[] = []
    if (query.projects?.some((id) => id !== null &&
      !db.prepare('SELECT id FROM todo_project WHERE id = ?').get(id))) result.push('project')
    if (query.tags?.some((id) => !db.prepare('SELECT id FROM todo_tag WHERE id = ?').get(id)))
      result.push('tag')
    return result
  }
  const saved = (row: Row): TodoSavedFilter => {
    const query = JSON.parse(row.query_json as string) as TodoQuery
    validateQuery(query)
    const missingReferences = missing(query)
    return { id: row.id as string, name: row.name as string, query,
      validity: missingReferences.length ? 'missingReferences' : 'valid', missingReferences }
  }

  return {
    getById, listOpen, listDone,
    create(value, legacyDay) {
      const input: TodoCreateInput = typeof value === 'string'
        ? { text: value, dueDay: legacyDay === undefined ? undefined : legacyDay }
        : value
      const createdAt = deps.now()
      const complete = { ...input, dueDay: input.dueDay === undefined
        ? dayKeyOf(createdAt) : input.dueDay }
      validateTask(complete)
      const id = deps.newId()
      db.prepare(`INSERT INTO todo_task
        (id, text, description, due_day, due_time, todo_project_id, priority, size,
         recurrence_mode, recurrence_unit, recurrence_interval, recurrence_anchor_day,
         sort_order, done_at, created_at)
        VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(id, complete.text.trim(), complete.dueDay, complete.dueTime ?? null,
          complete.projectId ?? null, complete.priority ?? 4, complete.size ?? null,
          complete.recurrence?.mode ?? null, complete.recurrence?.unit ?? null,
          complete.recurrence?.interval ?? null, complete.recurrence?.anchorDay ?? null,
          nextOrder(complete.projectId ?? null), createdAt)
      if (complete.tagIds?.length) writeTags(id, complete.tagIds)
      return mustGet(id)
    },
    update(id, patch) {
      const old = mustGet(id)
      const current: TodoCreateInput = { ...old, ...patch }
      validateTask(current)
      const scheduleChanged =
        (patch.dueDay !== undefined && patch.dueDay !== old.dueDay) ||
        (patch.dueTime !== undefined && patch.dueTime !== old.dueTime) ||
        (patch.recurrence !== undefined &&
          JSON.stringify(patch.recurrence) !== JSON.stringify(old.recurrence))
      return tx(db, () => {
        if (patch.projectId !== undefined && patch.projectId !== old.projectId) {
          db.prepare('UPDATE todo_task SET todo_project_id = ?, sort_order = ? WHERE id = ?')
            .run(patch.projectId, nextOrder(patch.projectId), id)
        }
        db.prepare(`UPDATE todo_task SET text = ?, description = ?, due_day = ?, due_time = ?,
          priority = ?, size = ?, recurrence_mode = ?, recurrence_unit = ?,
          recurrence_interval = ?, recurrence_anchor_day = ?,
          task_revision = task_revision + ? WHERE id = ?`)
          .run(current.text.trim(), patch.description ?? old.description, current.dueDay ?? null,
            current.dueTime ?? null, current.priority ?? 4, current.size ?? null,
            current.recurrence?.mode ?? null, current.recurrence?.unit ?? null,
            current.recurrence?.interval ?? null, current.recurrence?.anchorDay ?? null,
            scheduleChanged ? 1 : 0, id)
        if (patch.tagIds !== undefined) writeTags(id, patch.tagIds)
        return mustGet(id)
      })
    },
    complete(id, expectedRevision) {
      return tx(db, () => {
        const task = mustGet(id)
        if (task.revision !== expectedRevision || task.doneAt !== null)
          return { status: 'stale', task } as const
        if (!task.recurrence) {
          const completedAt = deps.now()
          const claim = db.prepare(`UPDATE todo_task SET done_at = ?, task_revision = task_revision + 1
            WHERE id = ? AND task_revision = ? AND done_at IS NULL`)
            .run(completedAt, id, expectedRevision)
          return { status: claim.changes ? 'completed' : 'stale', task: mustGet(id) } as const
        }
        const completedAt = deps.now()
        const today = dayKeyOf(completedAt)
        const next = nextOccurrence(task.recurrence, task.dueDay!, today)
        const claim = db.prepare(`UPDATE todo_task SET due_day = ?, task_revision = task_revision + 1
          WHERE id = ? AND task_revision = ? AND done_at IS NULL`)
          .run(next, id, expectedRevision)
        if (!claim.changes) return { status: 'stale', task: mustGet(id) } as const
        db.prepare(`INSERT INTO todo_completion
          (task_id, occurrence_revision, due_day, due_time, completed_at)
          VALUES (?, ?, ?, ?, ?)`)
          .run(id, expectedRevision, task.dueDay, task.dueTime ?? null, completedAt)
        return { status: 'completed', task: mustGet(id) } as const
      })
    },
    setDone(id, done) {
      const task = mustGet(id)
      if (task.recurrence) throw new Error('Recurring tasks require revision-checked completion')
      if (done) return this.complete(id, task.revision ?? 0).task
      db.prepare(`UPDATE todo_task SET done_at = NULL, sort_order = ?,
        task_revision = task_revision + 1 WHERE id = ?`).run(nextOrder(task.projectId ?? null), id)
      return mustGet(id)
    },
    history(id) {
      mustGet(id)
      return (db.prepare(`SELECT task_id, occurrence_revision, due_day, due_time, completed_at
        FROM todo_completion WHERE task_id = ? ORDER BY completed_at DESC`).all(id) as Row[])
        .map((row) => ({ taskId: row.task_id as string,
          occurrenceRevision: row.occurrence_revision as number,
          dueDay: row.due_day as string, dueTime: row.due_time as string | null,
          completedAt: row.completed_at as number }))
    },
    remove(id) { db.prepare('DELETE FROM todo_task WHERE id = ?').run(id) },
    reorder(ids, projectId = null) {
      const current = listOpen().filter((task) => task.projectId === projectId)
      const existing = new Set(current.map((task) => task.id))
      if (ids.length !== existing.size || new Set(ids).size !== ids.length ||
        ids.some((id) => !existing.has(id)))
        throw new Error('Reorder must contain every open task exactly once in the project')
      return tx(db, () => {
        const update = db.prepare(`UPDATE todo_task SET sort_order = ? WHERE id = ?
          AND done_at IS NULL AND todo_project_id IS ?`)
        ids.forEach((id, index) => {
          if (update.run(index, id, projectId).changes !== 1)
            throw new Error(`Open task not found while reordering: ${id}`)
        })
        return listOpen().filter((task) => task.projectId === projectId)
      })
    },
    listProjects() { return (db.prepare('SELECT id, name, sort_order FROM todo_project ORDER BY sort_order')
      .all() as Row[]).map((row) => ({ id: row.id as string, name: row.name as string,
        sortOrder: row.sort_order as number })) },
    createProject(name) {
      const id = deps.newId()
      db.prepare(`INSERT INTO todo_project(id, name, normalized_name, sort_order, created_at)
        VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM todo_project), ?)`)
        .run(id, nameOf(name), normalized(name), deps.now())
      return this.listProjects().find((project) => project.id === id)!
    },
    updateProject(id, name) {
      if (!db.prepare('SELECT id FROM todo_project WHERE id = ?').get(id)) throw new Error('TODO project not found')
      db.prepare('UPDATE todo_project SET name = ?, normalized_name = ? WHERE id = ?')
        .run(nameOf(name), normalized(name), id)
      return this.listProjects().find((project) => project.id === id)!
    },
    removeProject(id) {
      tx(db, () => {
        const tasks = listOpen().filter((task) => task.projectId === id)
        for (const task of tasks) db.prepare(`UPDATE todo_task SET todo_project_id = NULL,
          sort_order = ? WHERE id = ?`).run(nextOrder(null), task.id)
        db.prepare('UPDATE todo_task SET todo_project_id = NULL WHERE todo_project_id = ?').run(id)
        db.prepare('DELETE FROM todo_project WHERE id = ?').run(id)
      })
    },
    listTags() { return (db.prepare('SELECT id, name FROM todo_tag ORDER BY name').all() as Row[])
      .map((row) => ({ id: row.id as string, name: row.name as string })) },
    createTag(name) {
      const id = deps.newId()
      db.prepare('INSERT INTO todo_tag(id, name, normalized_name) VALUES (?, ?, ?)')
        .run(id, nameOf(name), normalized(name))
      return this.listTags().find((tag) => tag.id === id)!
    },
    updateTag(id, name) {
      if (!db.prepare('SELECT id FROM todo_tag WHERE id = ?').get(id)) throw new Error('TODO tag not found')
      db.prepare('UPDATE todo_tag SET name = ?, normalized_name = ? WHERE id = ?')
        .run(nameOf(name), normalized(name), id)
      return this.listTags().find((tag) => tag.id === id)!
    },
    removeTag(id) { db.prepare('DELETE FROM todo_tag WHERE id = ?').run(id) },
    listFilters() { return (db.prepare('SELECT id, name, query_json FROM todo_saved_filter ORDER BY created_at')
      .all() as Row[]).map(saved) },
    createFilter(name, query) {
      validateQuery(query)
      const id = deps.newId()
      db.prepare('INSERT INTO todo_saved_filter(id, name, query_json, created_at) VALUES (?, ?, ?, ?)')
        .run(id, nameOf(name), JSON.stringify(query), deps.now())
      return this.listFilters().find((filter) => filter.id === id)!
    },
    updateFilter(id, name, query) {
      validateQuery(query)
      if (!db.prepare('SELECT id FROM todo_saved_filter WHERE id = ?').get(id))
        throw new Error('TODO filter not found')
      db.prepare('UPDATE todo_saved_filter SET name = ?, query_json = ? WHERE id = ?')
        .run(nameOf(name), JSON.stringify(query), id)
      return this.listFilters().find((filter) => filter.id === id)!
    },
    removeFilter(id) { db.prepare('DELETE FROM todo_saved_filter WHERE id = ?').run(id) },
    query(query, today) {
      validateQuery(query)
      const missingReferences = missing(query)
      if (missingReferences.length) return { status: 'invalid', missingReferences }
      return { status: 'valid', tasks: listOpen().filter((task) =>
        matchesQuery(task, query, today)).sort(byDue) }
    }
  }
}
