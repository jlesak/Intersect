import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoReminder } from '@common/coreBridge'
import type { Logger } from '@common/logging/logger'
import type { PendingReminder } from './plan'
import type { AuthorizationStatus, NativeReminders, ReminderRequest } from './native'
import { createReminderService, type HistoryNotification, type ReminderService } from './service'

// 13 Nov 2026, 14:00 local time.
const START = new Date(2026, 10, 13, 14, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function reminder(taskId: string, minutesFromStart: number, overrides: Partial<TodoReminder> = {})
  : TodoReminder {
  const at = new Date(START.getTime() + minutesFromStart * MINUTE)
  return {
    id: `todo-reminder:${taskId}`,
    taskId,
    title: `Task ${taskId}`,
    body: 'Due · Inbox',
    fireAt: at.getTime(),
    local: { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate(),
      hour: at.getHours(), minute: at.getMinutes() },
    ...overrides
  }
}

/** A pending store with UserNotifications semantics: replace by id, remove by id. */
function fakeNative(status: AuthorizationStatus = 'authorized') {
  const pending = new Map<string, PendingReminder>()
  let inFlight = 0
  let maxInFlight = 0
  const native = {
    status,
    granted: true,
    get maxInFlight() {
      return maxInFlight
    },
    authorizationStatus: vi.fn(async () => native.status),
    requestAuthorization: vi.fn(async () => {
      native.status = native.granted ? 'authorized' : 'denied'
      return native.granted
    }),
    schedule: vi.fn(async (requests: ReminderRequest[]) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      for (const r of requests) {
        pending.set(r.id, { id: r.id, title: r.title, body: r.body, local: { ...r.local } })
      }
      inFlight -= 1
    }),
    cancel: vi.fn((ids: string[]) => {
      for (const id of ids) pending.delete(id)
    }),
    pending: vi.fn(async () => [...pending.values()].map((p) => ({ ...p })))
  }
  return { native: native as NativeReminders, store: pending, fake: native }
}

/** A restored Notification Center entry as `Notification.getHistory()` returns it. */
function historyObject(id: string) {
  const listeners: (() => void)[] = []
  const obj = {
    id,
    close: vi.fn(),
    show: vi.fn(),
    on: vi.fn((event: 'click', listener: () => void) => {
      if (event === 'click') listeners.push(listener)
      return obj
    }),
    click: () => listeners.forEach((l) => l())
  }
  return obj
}

function fakeLogger() {
  const calls: { level: string; msg: string }[] = []
  const at = (level: string) => (msg: string) => {
    calls.push({ level, msg })
  }
  const logger: Logger = {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    child: () => logger
  }
  return { logger, calls }
}

let history: ReturnType<typeof historyObject>[]
let getHistory: ReturnType<typeof vi.fn<() => Promise<HistoryNotification[]>>>
let activate: ReturnType<typeof vi.fn<(taskId: string) => void>>
let log: ReturnType<typeof fakeLogger>
let service: ReminderService | null

function makeService(native: NativeReminders): ReminderService {
  service = createReminderService({
    native,
    getHistory,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    now: () => Date.now(),
    activation: { activate },
    logger: log.logger
  })
  return service
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  history = []
  getHistory = vi.fn(async () => [...history])
  activate = vi.fn()
  log = fakeLogger()
  service = null
})

afterEach(() => {
  service?.dispose()
  vi.useRealTimers()
})

describe('startup', () => {
  test('reads the Notification Center history once, even with no reminders', async () => {
    const s = makeService(fakeNative().native)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(getHistory).toHaveBeenCalledTimes(1)
  })
})

describe('adoptHistory', () => {
  test('keeps one object per reminder, closes the rest, and routes its click to the task', async () => {
    const s = makeService(fakeNative().native)
    const first = historyObject('todo-reminder:t1')
    history = [first]
    await s.refreshHistory()

    const session = historyObject('8c1f0f8e-session-banner')
    const duplicate = historyObject('todo-reminder:t1')
    const fresh = historyObject('todo-reminder:t2')
    history = [session, duplicate, fresh]
    await s.refreshHistory()

    expect(session.close).toHaveBeenCalledTimes(1)
    expect(duplicate.close).toHaveBeenCalledTimes(1)
    expect(fresh.close).not.toHaveBeenCalled()
    expect(first.close).not.toHaveBeenCalled()
    expect(session.on).not.toHaveBeenCalled()
    expect(duplicate.on).not.toHaveBeenCalled()

    fresh.click()
    expect(activate).toHaveBeenCalledWith('t2')
    first.click()
    expect(activate).toHaveBeenLastCalledWith('t1')
  })

  test('a clicked entry is let go, so the next delivery of that task is adopted afresh', async () => {
    const s = makeService(fakeNative().native)
    const first = historyObject('todo-reminder:t1')
    history = [first]
    await s.refreshHistory()
    first.click()

    const next = historyObject('todo-reminder:t1')
    history = [next]
    await s.refreshHistory()
    expect(next.close).not.toHaveBeenCalled()
    next.click()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  test('an entry that is neither wanted nor delivered any more is let go', async () => {
    const s = makeService(fakeNative().native)
    const first = historyObject('todo-reminder:t1')
    history = [first]
    await s.refreshHistory()
    history = []
    await s.refreshHistory()

    const again = historyObject('todo-reminder:t1')
    history = [again]
    await s.refreshHistory()
    expect(again.close).not.toHaveBeenCalled()
  })

  test('an entry that is still wanted stays attached while it is not delivered', async () => {
    const { native } = fakeNative()
    const s = makeService(native)
    await s.apply([reminder('t1', 60)])
    const first = historyObject('todo-reminder:t1')
    history = [first]
    await s.refreshHistory()
    history = []
    await s.refreshHistory()

    const next = historyObject('todo-reminder:t1')
    history = [next]
    await s.refreshHistory()
    expect(next.close).toHaveBeenCalledTimes(1)
  })
})

describe('fire-time polls', () => {
  test('poll the history at +2, +5 and +15 s after the fire time', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(getHistory).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getHistory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getHistory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getHistory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getHistory).toHaveBeenCalledTimes(3)
  })

  test('stop once the delivered reminder is present', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 2000)
    expect(getHistory).toHaveBeenCalledTimes(1)
    history = [historyObject('todo-reminder:t1')]
    await vi.advanceTimersByTimeAsync(3000)
    expect(getHistory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getHistory).toHaveBeenCalledTimes(2)
  })

  test('an apply after the fire time that drops the fired id keeps its polls', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 1000)
    await s.apply([])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getHistory).toHaveBeenCalledTimes(3)
  })

  test('an apply before the fire time that removes the id cancels its timer', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await vi.advanceTimersByTimeAsync(MINUTE)
    await s.apply([])
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(getHistory).not.toHaveBeenCalled()
  })

  test('an apply in the last 5 s before the fire time keeps the timer, the reminder still fires', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 3000)
    await s.apply([])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getHistory).toHaveBeenCalledTimes(3)
  })

  test('an apply that moves the time re-arms the timer at the new time', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 10)])
    await s.apply([reminder('t1', 30)])
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(getHistory).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 2000)
    expect(getHistory).toHaveBeenCalledTimes(1)
  })

  test('timers are armed only for reminders due within 24 hours', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('later', 25 * 60)])
    await vi.advanceTimersByTimeAsync(26 * HOUR)
    expect(getHistory).not.toHaveBeenCalled()

    await s.apply([reminder('soon', 26 * 60 + 23 * 60)])
    await vi.advanceTimersByTimeAsync(23 * HOUR + 2000)
    expect(getHistory).toHaveBeenCalledTimes(1)
  })
})

describe('waking from sleep', () => {
  // Timers in main measure a clock that stops while the Mac sleeps. vi.setSystemTime moves the
  // wall clock and leaves every fake timer with the time it had left, which is what a sleep does.
  const sleepUntil = (ms: number): void => {
    vi.setSystemTime(ms)
  }

  test('a timer delayed by the sleep is re-armed at the wall-clock fire time', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 60)])
    sleepUntil(START.getTime() + 30 * MINUTE)
    s.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(getHistory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(getHistory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getHistory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(getHistory).toHaveBeenCalledTimes(4)
    // The timer armed before the sleep would fire 30 minutes late; it must be gone.
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getHistory).toHaveBeenCalledTimes(4)
  })

  test('a reminder beyond 24 hours at the last apply gets its timer when the wake brings it close', async () => {
    const s = makeService(fakeNative().native)
    // Friday 14:00 apply, Monday 14:00 reminder, the Mac sleeps over the weekend.
    await s.apply([reminder('monday', 72 * 60)])
    sleepUntil(START.getTime() + 72 * HOUR - 5 * MINUTE)
    s.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(getHistory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 2000)
    expect(getHistory).toHaveBeenCalledTimes(2)
  })

  test('a reminder whose time passed during the sleep is polled for after the wake', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 60)])
    sleepUntil(START.getTime() + 90 * MINUTE)
    s.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(getHistory).toHaveBeenCalledTimes(1)
    // macOS delivers it a moment after the wake.
    const delivered = historyObject('todo-reminder:t1')
    history = [delivered]
    await vi.advanceTimersByTimeAsync(2000)
    expect(getHistory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getHistory).toHaveBeenCalledTimes(2)
    delivered.click()
    expect(activate).toHaveBeenCalledWith('t1')
  })

  test('the wake polls run at +2, +5 and +15 s while the passed reminder is not delivered', async () => {
    const s = makeService(fakeNative().native)
    await s.apply([reminder('t1', 60)])
    sleepUntil(START.getTime() + 90 * MINUTE)
    s.resume()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getHistory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getHistory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getHistory).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getHistory).toHaveBeenCalledTimes(4)
  })
})

describe('reconcile', () => {
  test('schedules the wanted reminders with their content and time', async () => {
    const { native, store } = fakeNative()
    const s = makeService(native)
    await s.apply([reminder('t1', 30, { title: 'Ship', body: 'Due 14:30 · Build' })])
    expect([...store.values()]).toEqual([{ id: 'todo-reminder:t1', title: 'Ship',
      body: 'Due 14:30 · Build', local: { year: 2026, month: 11, day: 13, hour: 14, minute: 30 } }])
  })

  test('applying the same list twice schedules once', async () => {
    const { native, fake } = fakeNative()
    const s = makeService(native)
    await s.apply([reminder('t1', 30)])
    await s.apply([reminder('t1', 30)])
    expect(fake.schedule).toHaveBeenCalledTimes(1)
  })

  test('runs one at a time and the latest list wins', async () => {
    const { native, store, fake } = fakeNative()
    const s = makeService(native)
    const first = s.apply([reminder('a', 30)])
    const second = s.apply([reminder('b', 40)])
    await Promise.all([first, second])
    expect([...store.keys()]).toEqual(['todo-reminder:b'])
    expect(fake.maxInFlight).toBe(1)
  })

  test('a change held by the guard is applied once the old reminder was delivered', async () => {
    const { native, store } = fakeNative()
    const s = makeService(native)
    await s.apply([reminder('t1', 30)])
    // Three seconds before 14:30 the user moves the task to 15:00.
    await vi.advanceTimersByTimeAsync(30 * MINUTE - 3000)
    await s.apply([reminder('t1', 60)])
    expect(store.get('todo-reminder:t1')?.local?.minute).toBe(30)
    // macOS delivers the 14:30 reminder, which takes it off the pending list.
    await vi.advanceTimersByTimeAsync(3000)
    store.delete('todo-reminder:t1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.get('todo-reminder:t1')?.local).toEqual(
      { year: 2026, month: 11, day: 13, hour: 15, minute: 0 })
  })

  test('a failing native call is logged and the next apply still runs', async () => {
    const { native, fake, store } = fakeNative()
    fake.pending.mockRejectedValueOnce(new Error('center unavailable'))
    const s = makeService(native)
    await expect(s.apply([reminder('t1', 30)])).resolves.toBeUndefined()
    expect(log.calls.filter((c) => c.level === 'error')).toHaveLength(1)
    await s.apply([reminder('t1', 30)])
    expect(store.has('todo-reminder:t1')).toBe(true)
  })
})

describe('permission', () => {
  test('a denied permission schedules nothing, throws nothing and logs once at info', async () => {
    const { native, fake } = fakeNative('denied')
    const s = makeService(native)
    await expect(s.apply([reminder('t1', 30)])).resolves.toBeUndefined()
    await s.apply([reminder('t1', 30), reminder('t2', 40)])
    expect(fake.schedule).not.toHaveBeenCalled()
    expect(fake.cancel).not.toHaveBeenCalled()
    expect(log.calls.filter((c) => c.level === 'info')).toHaveLength(1)
    expect(log.calls.filter((c) => c.level === 'error' || c.level === 'warn')).toHaveLength(0)
  })

  test('an undecided permission is asked once, and a grant schedules the list', async () => {
    const { native, fake, store } = fakeNative('notDetermined')
    const s = makeService(native)
    await s.apply([reminder('t1', 30)])
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.requestAuthorization).toHaveBeenCalledTimes(1)
    expect(store.has('todo-reminder:t1')).toBe(true)
  })

  test('a prompt that is still open is not raised again by later applies', async () => {
    const { native, fake } = fakeNative('notDetermined')
    // The user has not answered yet, so the status stays undecided and the request never returns.
    fake.requestAuthorization.mockImplementation(() => new Promise<boolean>(() => {}))
    const s = makeService(native)
    await s.apply([reminder('t1', 30)])
    await s.apply([reminder('t1', 30), reminder('t2', 40)])
    await s.apply([reminder('t2', 40)])
    expect(fake.requestAuthorization).toHaveBeenCalledTimes(1)
    expect(fake.schedule).not.toHaveBeenCalled()
  })

  test('an undecided permission is not asked for while there is nothing to schedule', async () => {
    const { native, fake } = fakeNative('notDetermined')
    const s = makeService(native)
    await s.apply([])
    expect(fake.requestAuthorization).not.toHaveBeenCalled()
  })

  test('a refused request schedules nothing and logs once', async () => {
    const { native, fake } = fakeNative('notDetermined')
    fake.granted = false
    const s = makeService(native)
    await s.apply([reminder('t1', 30)])
    await vi.advanceTimersByTimeAsync(0)
    await s.apply([reminder('t1', 30)])
    expect(fake.requestAuthorization).toHaveBeenCalledTimes(1)
    expect(fake.schedule).not.toHaveBeenCalled()
    expect(log.calls.filter((c) => c.level === 'info')).toHaveLength(1)
  })
})

describe('delivery', () => {
  test('the service never shows a notification itself', async () => {
    const s = makeService(fakeNative().native)
    s.start()
    const delivered = historyObject('todo-reminder:t1')
    const session = historyObject('session')
    history = [delivered, session]
    await s.apply([reminder('t1', 1)])
    await vi.advanceTimersByTimeAsync(MINUTE + 20_000)
    delivered.click()
    expect(delivered.show).not.toHaveBeenCalled()
    expect(session.show).not.toHaveBeenCalled()
  })
})
