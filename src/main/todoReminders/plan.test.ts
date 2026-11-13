import { describe, expect, test } from 'vitest'
import type { TodoReminder } from '@common/coreBridge'
import { planSync, type PendingReminder } from './plan'

// Local wall-clock times, so the suite runs in any time zone.
const T1430 = new Date(2026, 10, 13, 14, 30).getTime()

function reminder(taskId: string, at: Date, overrides: Partial<TodoReminder> = {}): TodoReminder {
  return {
    id: `todo-reminder:${taskId}`,
    taskId,
    title: `Task ${taskId}`,
    body: 'Due 14:30 · Inbox',
    fireAt: at.getTime(),
    local: {
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes()
    },
    ...overrides
  }
}

/** What macOS reports back for a request scheduled from `r`. */
function pendingOf(r: TodoReminder): PendingReminder {
  return { id: r.id, title: r.title, body: r.body, local: { ...r.local } }
}

const at1430 = (): Date => new Date(T1430)
const at1500 = (): Date => new Date(2026, 10, 13, 15, 0)

describe('planSync', () => {
  test('applying the same list again changes nothing', () => {
    const desired = [reminder('a', at1430()), reminder('b', at1500())]
    const pending = desired.map(pendingOf)
    const now = T1430 - 60 * 60_000
    expect(planSync(pending, desired.map((r) => ({ ...r })), now))
      .toEqual({ add: [], remove: [], retryAt: null })
  })

  test('a wanted reminder that is not pending is added', () => {
    const desired = [reminder('a', at1430())]
    expect(planSync([], desired, T1430 - 60_000).add.map((r) => r.id)).toEqual(['todo-reminder:a'])
  })

  test('a pending request whose body changed is added again, which replaces it by id', () => {
    const before = reminder('a', at1430())
    const after = reminder('a', at1430(), { body: 'Due 14:30 · Build' })
    const result = planSync([pendingOf(before)], [after], T1430 - 60 * 60_000)
    expect(result.add).toEqual([after])
    expect(result.remove).toEqual([])
  })

  test('a pending request whose title or time changed is added again', () => {
    const before = reminder('a', at1430())
    const renamed = reminder('a', at1430(), { title: 'Renamed' })
    const moved = reminder('a', at1500())
    const now = T1430 - 60 * 60_000
    expect(planSync([pendingOf(before)], [renamed], now).add).toEqual([renamed])
    expect(planSync([pendingOf(before)], [moved], now).add).toEqual([moved])
  })

  test('an unwanted future request is removed', () => {
    const stale = reminder('gone', at1500())
    expect(planSync([pendingOf(stale)], [], T1430).remove).toEqual(['todo-reminder:gone'])
  })

  test('requests of other notifications are never touched', () => {
    const other: PendingReminder = { id: 'session-banner', title: 'x', body: 'y', local: null }
    expect(planSync([other], [], T1430)).toEqual({ add: [], remove: [], retryAt: null })
  })

  test('an unwanted request within (now - 60 s, now + 5 s] is kept, it may be firing', () => {
    const due = pendingOf(reminder('due', at1430()))
    for (const now of [T1430 - 5000, T1430, T1430 + 59_999]) {
      expect(planSync([due], [], now).remove).toEqual([])
    }
  })

  test('an unwanted request 60 s or more in the past is removed, macOS will never fire it', () => {
    const missed = pendingOf(reminder('missed', at1430()))
    expect(planSync([missed], [], T1430 + 61_000).remove).toEqual(['todo-reminder:missed'])
    expect(planSync([missed], [], T1430 + 60_000).remove).toEqual(['todo-reminder:missed'])
  })

  test('an unwanted request just beyond the guard is removed', () => {
    const soon = pendingOf(reminder('soon', at1430()))
    expect(planSync([soon], [], T1430 - 5001).remove).toEqual(['todo-reminder:soon'])
  })

  test('nothing is added for a fire time at or before now + 5 s', () => {
    const desired = [reminder('a', at1430())]
    expect(planSync([], desired, T1430 - 5000).add).toEqual([])
    expect(planSync([], desired, T1430 - 5001).add).toEqual(desired)
  })

  test('a changed request inside the guard is held, and a retry is asked for after it fires', () => {
    const firing = reminder('a', at1430())
    const moved = reminder('a', at1500())
    const result = planSync([pendingOf(firing)], [moved], T1430 - 3000)
    expect(result.add).toEqual([])
    expect(result.remove).toEqual([])
    expect(result.retryAt).toBe(T1430 + 2000)
  })

  test('a held request that is still pending after it should have fired is retried once it leaves the guard', () => {
    const firing = reminder('a', at1430())
    const moved = reminder('a', at1500())
    const result = planSync([pendingOf(firing)], [moved], T1430 + 30_000)
    expect(result.retryAt).toBe(T1430 + 60_001)
  })

  test('a past request that is wanted at a new time is replaced, not removed', () => {
    const missed = reminder('a', at1430())
    const next = reminder('a', at1500())
    const result = planSync([pendingOf(missed)], [next], T1430 + 61_000)
    expect(result.add).toEqual([next])
    expect(result.remove).toEqual([])
  })

  test('a stale request whose wanted time is too close to add is removed', () => {
    // The user moved the time from 15:00 to the current minute: 15:00 must not fire, and the new
    // time is too close to schedule.
    const old = reminder('a', at1500())
    const close = reminder('a', at1430())
    const result = planSync([pendingOf(old)], [close], T1430 - 2000)
    expect(result.add).toEqual([])
    expect(result.remove).toEqual(['todo-reminder:a'])
  })
})
