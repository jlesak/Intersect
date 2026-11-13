import type { TodoReminder } from '@common/coreBridge'
import type { Logger } from '@common/logging/logger'
import { taskIdFromReminderId } from '@common/todoReminder'
import type { ReminderActivation } from './activation'
import type { NativeReminders } from './native'
import { GUARD_AHEAD_MS, planSync } from './plan'

/** A delivered notification as `Notification.getHistory()` returns it. */
export interface HistoryNotification {
  readonly id: string
  close(): void
  on(event: 'click', listener: () => void): unknown
}

export interface ReminderTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ReminderServiceDeps {
  native: NativeReminders
  getHistory(): Promise<HistoryNotification[]>
  timers: ReminderTimers
  now(): number
  activation: Pick<ReminderActivation, 'activate'>
  logger: Logger
}

export interface ReminderService {
  /** Read the history once at startup. That also creates Electron's notification presenter. */
  start(): void
  /** Make macOS match this full list. Resolves when the reconcile that covers it has finished. */
  apply(reminders: TodoReminder[]): Promise<void>
  /** Attach clicks to delivered reminders. Resolves with the reminder ids that are delivered. */
  refreshHistory(): Promise<Set<string>>
  /**
   * The Mac woke from sleep. Timers measure a clock that stops during sleep, so every armed fire
   * timer is late by the length of the sleep. Re-arm them from the wall clock, and poll for the
   * reminders whose time passed while the Mac slept.
   */
  resume(): void
  dispose(): void
}

/** Fire-time timers are armed only this far ahead; the core's hourly refresh rolls the window. */
const TIMER_HORIZON_MS = 24 * 60 * 60 * 1000
/** When to look for a delivered reminder after its fire time or after a wake, relative to it. */
const POLL_OFFSETS_MS = [2_000, 5_000, 15_000]

/** A fire timer belongs to one reminder at one time, so a moved reminder can have two. */
const timerKey = (r: Pick<TodoReminder, 'id' | 'fireAt'>): string => `${r.id}@${r.fireAt}`

interface FireTimer {
  id: string
  fireAt: number
  handle: unknown
}

/**
 * Main's half of TODO reminders. macOS delivers every reminder itself; this service never shows
 * one. It makes the pending requests match the core's list, and it attaches a click listener to
 * each delivered reminder, so a click opens the task.
 *
 * Electron sends a click only to a live Notification object with that id. The restored objects of
 * `getHistory()` stay in Notification Center when collected, so the service keeps exactly one per
 * reminder id and closes every other object it gets: duplicates and other notifications such as
 * session banners. Closing a restored object leaves its entry in Notification Center and takes it
 * out of Electron's set, so a session banner's click still reaches its own live object.
 */
export function createReminderService(deps: ReminderServiceDeps): ReminderService {
  const { native, timers, logger } = deps
  const attached = new Map<string, HistoryNotification>()
  const fireTimers = new Map<string, FireTimer>()
  const pollHandles = new Set<unknown>()
  let retryHandle: unknown = null
  let latest: TodoReminder[] = []
  let wanted = new Set<string>()
  let running: Promise<void> | null = null
  let dirty = false
  let askedPermission = false
  let loggedDenied = false
  let disposed = false

  const logDenied = (): void => {
    if (loggedDenied) return
    loggedDenied = true
    logger.info('notification permission is denied, todo reminders are not scheduled')
  }

  const adoptHistory = (objects: HistoryNotification[]): Set<string> => {
    const delivered = new Set<string>()
    for (const object of objects) {
      const taskId = taskIdFromReminderId(object.id)
      if (taskId === null || attached.has(object.id)) {
        object.close()
        if (taskId !== null) delivered.add(object.id)
        continue
      }
      delivered.add(object.id)
      attached.set(object.id, object)
      object.on('click', () => {
        if (attached.get(object.id) === object) attached.delete(object.id)
        deps.activation.activate(taskId)
      })
    }
    for (const [id, object] of attached) {
      if (delivered.has(id) || wanted.has(id)) continue
      attached.delete(id)
      object.close()
    }
    return delivered
  }

  const refreshHistory = async (): Promise<Set<string>> => {
    try {
      return adoptHistory(await deps.getHistory())
    } catch (err) {
      logger.warn('reading the notification history failed', { err })
      return new Set()
    }
  }

  /** Poll at each offset after `base` until every one of `ids` is delivered. */
  const poll = (ids: string[], base: number, index: number): void => {
    if (disposed || index >= POLL_OFFSETS_MS.length) return
    const delay = Math.max(0, base + POLL_OFFSETS_MS[index] - deps.now())
    const handle = timers.setTimeout(() => {
      pollHandles.delete(handle)
      void refreshHistory().then((delivered) => {
        if (ids.some((id) => !delivered.has(id))) poll(ids, base, index + 1)
      })
    }, delay)
    pollHandles.add(handle)
  }

  /**
   * Keep a timer at each wanted fire time in the next 24 hours. A timer is cancelled only while its
   * time is still beyond the guard, so a reminder that macOS may already be delivering keeps it;
   * once a timer has fired, its polls run to the end whatever later applies do.
   */
  const armTimers = (reminders: readonly Pick<TodoReminder, 'id' | 'fireAt'>[]): void => {
    const now = deps.now()
    const wantedAt = new Set(reminders.map(timerKey))
    for (const [key, timer] of fireTimers) {
      if (wantedAt.has(key) || timer.fireAt <= now + GUARD_AHEAD_MS) continue
      timers.clearTimeout(timer.handle)
      fireTimers.delete(key)
    }
    for (const reminder of reminders) {
      const key = timerKey(reminder)
      if (fireTimers.has(key) || reminder.fireAt <= now ||
        reminder.fireAt > now + TIMER_HORIZON_MS) continue
      const handle = timers.setTimeout(() => {
        fireTimers.delete(key)
        poll([reminder.id], reminder.fireAt, 0)
      }, reminder.fireAt - now)
      fireTimers.set(key, { id: reminder.id, fireAt: reminder.fireAt, handle })
    }
  }

  const scheduleRetry = (at: number | null): void => {
    if (retryHandle !== null) timers.clearTimeout(retryHandle)
    retryHandle = null
    if (at === null || disposed) return
    retryHandle = timers.setTimeout(() => {
      retryHandle = null
      void drain()
    }, Math.max(0, at - deps.now()))
  }

  const askPermission = (): void => {
    askedPermission = true
    native.requestAuthorization().then(
      (granted) => {
        if (granted) void drain()
        else logDenied()
      },
      (err) => logger.warn('asking for notification permission failed', { err })
    )
  }

  const reconcile = async (desired: TodoReminder[]): Promise<void> => {
    try {
      const status = await native.authorizationStatus()
      if (status === 'denied') {
        logDenied()
        return
      }
      if (status === 'notDetermined') {
        // The answer can take as long as the user likes, so it must not hold up later runs.
        if (desired.length > 0 && !askedPermission) askPermission()
        return
      }
      const plan = planSync(await native.pending(), desired, deps.now())
      if (plan.remove.length > 0) native.cancel(plan.remove)
      if (plan.add.length > 0) {
        await native.schedule(plan.add.map(({ id, title, body, local }) => ({ id, title, body, local })))
      }
      scheduleRetry(plan.retryAt)
    } catch (err) {
      logger.error('todo reminder sync failed', { err })
    }
  }

  /** Runs reconciles one at a time; a list that arrives during a run is reconciled after it. */
  const drain = (): Promise<void> => {
    if (running) {
      dirty = true
      return running
    }
    running = (async () => {
      try {
        do {
          dirty = false
          await reconcile(latest)
        } while (dirty && !disposed)
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    start() {
      void refreshHistory()
    },
    apply(reminders) {
      latest = reminders
      wanted = new Set(reminders.map((r) => r.id))
      armTimers(reminders)
      return drain()
    },
    refreshHistory,
    resume() {
      const now = deps.now()
      // A timer the guard kept for a reminder that is no longer wanted at that time (moved or
      // completed in its last 5 s) still stands for one that macOS delivers, so it is re-armed or
      // polled for like a wanted one.
      const wantedAt = new Set(latest.map(timerKey))
      const kept = [...fireTimers.values()].filter(
        (timer) => timer.fireAt <= now + GUARD_AHEAD_MS && !wantedAt.has(timerKey(timer)))
      for (const timer of fireTimers.values()) timers.clearTimeout(timer.handle)
      fireTimers.clear()
      // The 24-hour window is measured from now, so a reminder that was too far ahead at the last
      // apply gets its timer without waiting for the core's next hourly refresh.
      armTimers([...latest, ...kept])
      const passed = [...latest, ...kept].filter((r) => r.fireAt <= now).map((r) => r.id)
      void refreshHistory().then((delivered) => {
        const missing = passed.filter((id) => !delivered.has(id))
        if (missing.length > 0) poll(missing, now, 0)
      })
    },
    dispose() {
      disposed = true
      for (const timer of fireTimers.values()) timers.clearTimeout(timer.handle)
      fireTimers.clear()
      for (const handle of pollHandles) timers.clearTimeout(handle)
      pollHandles.clear()
      if (retryHandle !== null) timers.clearTimeout(retryHandle)
      retryHandle = null
    }
  }
}
