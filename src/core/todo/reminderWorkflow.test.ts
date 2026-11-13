import { beforeEach, describe, expect, test } from 'vitest'
import type { TodoReminder } from '@common/coreBridge'
import type { Logger } from '@common/logging/logger'
import { planSync, type PendingReminder } from '../../main/todoReminders/plan'
import { createTodoHandlers, type TodoHandlers } from '../api/todo.ipc'
import { createTodoRepo, type TodoRepo } from '../db/todoRepo'
import { makeTestDb } from '../db/testkit'
import { createTodoReminderSync, type TodoReminderSync } from './reminders'

/**
 * The whole TODO reminder workflow with only macOS faked: the real repository on an in-memory
 * database, the real handlers, the real reminder rules, and main's real reconcile against a pending
 * store with UserNotifications semantics (a request with an existing id replaces it, cancel
 * removes by id, and a request keeps its title, body and local time).
 */

// 13 Nov 2026, 10:00 local time.
const START = new Date(2026, 10, 13, 10, 0).getTime()
const TODAY = '2026-11-13'
const TOMORROW = '2026-11-14'

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger
}

let clock: number
let pending: Map<string, PendingReminder>
let applied: number
/** Every request id handed to macOS, in order, so a request asked for twice shows up twice. */
let scheduled: string[]
let failApply: boolean
let todos: TodoRepo
let sync: TodoReminderSync
let h: TodoHandlers

/** Main's side of the push: reconcile the fake pending store with the wanted list. */
function applyToMacos(reminders: TodoReminder[]): void {
  applied += 1
  if (failApply) throw new Error('scheduler is gone')
  const plan = planSync([...pending.values()], reminders, clock)
  for (const id of plan.remove) pending.delete(id)
  for (const r of plan.add) {
    scheduled.push(r.id)
    pending.set(r.id, { id: r.id, title: r.title, body: r.body, local: { ...r.local } })
  }
}

const only = (): PendingReminder => {
  expect(pending.size).toBe(1)
  return [...pending.values()][0]
}

beforeEach(() => {
  clock = START
  pending = new Map()
  applied = 0
  scheduled = []
  failApply = false
  let ids = 0
  todos = createTodoRepo(makeTestDb(), { now: () => clock, newId: () => `task${++ids}` })
  sync = createTodoReminderSync({
    listOpen: () => todos.listOpen(),
    listProjects: () => todos.listProjects(),
    now: () => clock,
    apply: applyToMacos,
    logger: silentLogger
  })
  h = createTodoHandlers({ todos, onChanged: () => sync.refresh() })
})

describe('saving a task schedules its reminder', () => {
  test('a future task with a date and a time leaves one pending request at that time', async () => {
    const project = await h.createProject('Build')
    const task = await h.add({ text: 'Ship it', dueDay: TOMORROW, dueTime: '14:30',
      projectId: project.id })
    expect(only()).toEqual({
      id: `todo-reminder:${task.id}`,
      title: 'Ship it',
      body: 'Due 14:30 · Build',
      local: { year: 2026, month: 11, day: 14, hour: 14, minute: 30 }
    })
  })

  test('a task with only a date, or the default today, leaves none', async () => {
    await h.add({ text: 'Date only', dueDay: TOMORROW })
    await h.add({ text: 'Default today' })
    expect(applied).toBe(2)
    expect(pending.size).toBe(0)
  })
})

describe('changing a task updates or cancels its reminder', () => {
  test('changing the date, then the time, moves the same request', async () => {
    const task = await h.add({ text: 'Move me', dueDay: TOMORROW, dueTime: '14:30' })
    await h.update(task.id, { dueDay: '2026-11-20' })
    expect(only().local).toEqual({ year: 2026, month: 11, day: 20, hour: 14, minute: 30 })
    await h.update(task.id, { dueTime: '08:15' })
    expect(only()).toMatchObject({ id: `todo-reminder:${task.id}`,
      local: { year: 2026, month: 11, day: 20, hour: 8, minute: 15 }, body: 'Due 08:15 · Inbox' })
  })

  test('changing only the text updates the title', async () => {
    const task = await h.add({ text: 'Old text', dueDay: TOMORROW, dueTime: '14:30' })
    await h.update(task.id, { text: 'New text' })
    expect(only().title).toBe('New text')
  })

  test('renaming the project updates the body, deleting it shows Inbox', async () => {
    const project = await h.createProject('Build')
    await h.add({ text: 'In a project', dueDay: TOMORROW, dueTime: '14:30', projectId: project.id })
    await h.updateProject(project.id, 'Release')
    expect(only().body).toBe('Due 14:30 · Release')
    await h.removeProject(project.id)
    expect(only().body).toBe('Due 14:30 · Inbox')
  })

  test('clearing the time cancels the request', async () => {
    const task = await h.add({ text: 'Timed', dueDay: TOMORROW, dueTime: '14:30' })
    await h.update(task.id, { dueTime: null })
    expect(pending.size).toBe(0)
  })

  test('completing a one-off task cancels it, unchecking it brings it back', async () => {
    const task = await h.add({ text: 'Once', dueDay: TOMORROW, dueTime: '14:30' })
    await h.complete(task.id, task.revision!)
    expect(pending.size).toBe(0)
    await h.setDone(task.id, false)
    expect(only().id).toBe(`todo-reminder:${task.id}`)
    await h.setDone(task.id, true)
    expect(pending.size).toBe(0)
  })

  test('deleting the task cancels it', async () => {
    const task = await h.add({ text: 'Doomed', dueDay: TOMORROW, dueTime: '14:30' })
    await h.remove(task.id)
    expect(pending.size).toBe(0)
  })

  test('completing a recurring timed task moves the request to the next occurrence', async () => {
    const task = await h.add({ text: 'Daily standup', dueDay: TODAY, dueTime: '14:30',
      recurrence: { mode: 'fixed', unit: 'day', interval: 1, anchorDay: TODAY } })
    expect(only().local).toEqual({ year: 2026, month: 11, day: 13, hour: 14, minute: 30 })
    await h.complete(task.id, task.revision!)
    expect(only()).toMatchObject({ id: `todo-reminder:${task.id}`,
      local: { year: 2026, month: 11, day: 14, hour: 14, minute: 30 } })
  })

  test('a recurring task without a time has no request', async () => {
    const task = await h.add({ text: 'Daily, no time', dueDay: TODAY,
      recurrence: { mode: 'fixed', unit: 'day', interval: 1, anchorDay: TODAY } })
    await h.complete(task.id, task.revision!)
    expect(pending.size).toBe(0)
  })

  test('reordering and tag edits do not recompute the reminders', async () => {
    const a = await h.add({ text: 'a', dueDay: TOMORROW, dueTime: '14:30' })
    const b = await h.add({ text: 'b', dueDay: TOMORROW })
    const before = applied
    await h.reorder([b.id, a.id], null)
    const tag = await h.createTag('Quick')
    await h.updateTag(tag.id, 'Fast')
    await h.removeTag(tag.id)
    expect(applied).toBe(before)
  })
})

describe('restarts and failures', () => {
  test('two boot refreshes leave one pending request per task and ask macOS for nothing again', async () => {
    const a = await h.add({ text: 'a', dueDay: TOMORROW, dueTime: '14:30' })
    const b = await h.add({ text: 'b', dueDay: TOMORROW, dueTime: '15:00' })
    sync.refresh()
    clock += 60_000
    sync.refresh()
    const ids = [`todo-reminder:${a.id}`, `todo-reminder:${b.id}`]
    expect([...pending.keys()].sort()).toEqual(ids)
    // The pending store cannot hold two requests with one id, so the proof that a restart does not
    // duplicate is that it does not schedule an unchanged reminder again at all.
    expect(scheduled).toEqual(ids)
  })

  test('every TODO operation still succeeds when the scheduler throws', async () => {
    failApply = true
    const task = await h.add({ text: 'Still saved', dueDay: TOMORROW, dueTime: '14:30' })
    const updated = await h.update(task.id, { dueTime: '15:00' })
    await h.complete(updated.id, updated.revision!)
    expect(applied).toBe(3)
    expect((await h.list()).done.map((t) => t.text)).toEqual(['Still saved'])
  })
})
