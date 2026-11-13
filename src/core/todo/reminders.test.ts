import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TodoProject, TodoTask } from '@common/domain'
import type { Logger } from '@common/logging/logger'
import { createTodoReminderSync, planReminders, REMINDER_LIMIT } from './reminders'

// 13 Nov 2026, 10:00 local time. Every time below is local, so the suite runs in any time zone.
const NOW = new Date(2026, 10, 13, 10, 0).getTime()

function task(overrides: Partial<TodoTask> = {}): TodoTask {
  return {
    id: 't1',
    text: 'Send the report',
    description: '',
    dueDay: '2026-11-14',
    dueTime: '14:30',
    priority: 4,
    sortOrder: 0,
    doneAt: null,
    projectId: null,
    recurrence: null,
    ...overrides
  }
}

const projects = (): TodoProject[] => [{ id: 'p1', name: 'Build', sortOrder: 0 }]

function fakeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = []
  const at = (level: string) => (msg: string) => {
    calls.push({ level, msg })
  }
  const logger = {
    calls,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    child: () => logger
  }
  return logger
}

describe('planReminders', () => {
  test('a future task with a date and a time gets one reminder at its local time', () => {
    const reminders = planReminders([task({ projectId: 'p1' })], projects(), NOW)
    expect(reminders).toEqual([
      {
        id: 'todo-reminder:t1',
        taskId: 't1',
        title: 'Send the report',
        body: 'Due 14:30 · Build',
        fireAt: new Date(2026, 10, 14, 14, 30).getTime(),
        local: { year: 2026, month: 11, day: 14, hour: 14, minute: 30 }
      }
    ])
  })

  test('a task in the Inbox names the Inbox in the body', () => {
    const [reminder] = planReminders([task({ dueTime: '09:05' })], projects(), NOW)
    expect(reminder.body).toBe('Due 09:05 · Inbox')
  })

  test('a task with only a date gets no reminder', () => {
    expect(planReminders([task({ dueTime: null })], projects(), NOW)).toEqual([])
  })

  test('a task created with the default today and no time gets no reminder', () => {
    expect(planReminders([task({ dueDay: '2026-11-13', dueTime: null })], projects(), NOW))
      .toEqual([])
  })

  test('a time earlier today gets none, a time later today gets one', () => {
    const earlier = task({ id: 'early', dueDay: '2026-11-13', dueTime: '09:59' })
    const now = task({ id: 'now', dueDay: '2026-11-13', dueTime: '10:00' })
    const later = task({ id: 'late', dueDay: '2026-11-13', dueTime: '10:01' })
    expect(planReminders([earlier, now, later], projects(), NOW).map((r) => r.taskId))
      .toEqual(['late'])
  })

  test('a done task gets no reminder', () => {
    expect(planReminders([task({ doneAt: NOW - 1000 })], projects(), NOW)).toEqual([])
  })

  test('the list is sorted by fire time and holds only the soonest 60', () => {
    // 65 tasks one minute apart, handed over in reverse order.
    const many = Array.from({ length: 65 }, (_, i) => {
      const minute = 11 * 60 + i
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
      return task({ id: `t${i}`, dueDay: '2026-11-13', dueTime: time })
    }).reverse()
    const reminders = planReminders(many, projects(), NOW)
    expect(REMINDER_LIMIT).toBe(60)
    expect(reminders).toHaveLength(60)
    expect(reminders.map((r) => r.taskId)).toEqual(Array.from({ length: 60 }, (_, i) => `t${i}`))
  })

  describe('a time inside the spring DST gap', () => {
    const original = process.env.TZ
    afterEach(() => {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    })

    // 29 Mar 2026 in Prague jumps from 02:00 to 03:00, so 02:30 never happens. The reminder keeps
    // the task's wall-clock fields, which macOS never matches, and its fire time is the first
    // instant after the gap. Main's guard therefore removes the request 60 s after 03:30, so it
    // does not hold one of the system's slots forever.
    test('keeps the wall-clock fields and fires at the first instant after the gap', () => {
      process.env.TZ = 'Europe/Prague'
      const now = new Date(2026, 2, 28, 12, 0).getTime()
      const [reminder] = planReminders(
        [task({ dueDay: '2026-03-29', dueTime: '02:30' })], projects(), now)
      expect(reminder.local).toEqual({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 })
      expect(new Date(reminder.fireAt).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    })
  })
})

describe('createTodoReminderSync', () => {
  test('a refresh hands the planned list to apply', () => {
    const apply = vi.fn()
    const sync = createTodoReminderSync({
      listOpen: () => [task()],
      listProjects: projects,
      now: () => NOW,
      apply,
      logger: fakeLogger()
    })
    sync.refresh()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0].map((r: { id: string }) => r.id)).toEqual(['todo-reminder:t1'])
  })

  test('a failing apply is logged and never thrown to the caller', () => {
    const logger = fakeLogger()
    const sync = createTodoReminderSync({
      listOpen: () => [task()],
      listProjects: projects,
      now: () => NOW,
      apply: () => {
        throw new Error('port closed')
      },
      logger
    })
    expect(() => sync.refresh()).not.toThrow()
    expect(logger.calls).toEqual([{ level: 'error', msg: 'todo reminder refresh failed' }])
  })

  test('a failing read is logged and never thrown to the caller', () => {
    const logger = fakeLogger()
    const apply = vi.fn()
    const sync = createTodoReminderSync({
      listOpen: () => {
        throw new Error('database is closed')
      },
      listProjects: projects,
      now: () => NOW,
      apply,
      logger
    })
    expect(() => sync.refresh()).not.toThrow()
    expect(apply).not.toHaveBeenCalled()
    expect(logger.calls.map((c) => c.level)).toEqual(['error'])
  })
})
