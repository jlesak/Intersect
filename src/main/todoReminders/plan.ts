import type { TodoReminder, TodoReminderLocalTime } from '@common/coreBridge'
import { taskIdFromReminderId } from '@common/todoReminder'

/** One pending notification request as macOS reports it. `local` is null for a non-calendar trigger. */
export interface PendingReminder {
  id: string
  title: string
  body: string
  local: TodoReminderLocalTime | null
}

export interface SyncPlan {
  /** Requests to schedule. One with the id of a pending request replaces it. */
  add: TodoReminder[]
  /** Pending request ids to cancel. */
  remove: string[]
  /** When to reconcile again because a changed request was held by the guard, or null. */
  retryAt: number | null
}

/** A request this close to its time may be firing right now and is never removed or replaced. */
export const GUARD_AHEAD_MS = 5_000
/** A request this far in the past may still be on its way; after it, macOS will not fire it. */
export const GUARD_BEHIND_MS = 60_000
/** How long after its time a delivered request has left the pending list. */
const DELIVERY_MS = 2_000

/** The epoch milliseconds of a local calendar time in this process's time zone. */
export function localTimeMs(local: TodoReminderLocalTime): number {
  return new Date(local.year, local.month - 1, local.day, local.hour, local.minute).getTime()
}

function sameLocal(a: TodoReminderLocalTime | null, b: TodoReminderLocalTime): boolean {
  return a !== null && a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute
}

function sameContent(pending: PendingReminder, wanted: TodoReminder): boolean {
  return pending.title === wanted.title && pending.body === wanted.body &&
    sameLocal(pending.local, wanted.local)
}

/**
 * The changes that make the pending TODO requests match the wanted list. Only requests with the
 * TODO reminder prefix are considered; every other notification of the app is left alone.
 *
 * A request whose trigger is within `(now - 60 s, now + 5 s]` is never removed or replaced, so a
 * save in the last seconds before a reminder cannot cancel one that is just arriving. Nothing is
 * added for a fire time at or before `now + 5 s`. A request more than 60 s past its time that is
 * not wanted is removed, so one macOS never fires, such as a time in a DST gap, does not hold a
 * slot forever.
 */
export function planSync(
  pending: readonly PendingReminder[],
  desired: readonly TodoReminder[],
  now: number
): SyncPlan {
  const pendingById = new Map<string, PendingReminder>()
  for (const request of pending) {
    if (taskIdFromReminderId(request.id) !== null) pendingById.set(request.id, request)
  }
  const triggerOf = (request: PendingReminder): number | null =>
    request.local === null ? null : localTimeMs(request.local)
  const inGuard = (trigger: number | null): boolean =>
    trigger !== null && trigger > now - GUARD_BEHIND_MS && trigger <= now + GUARD_AHEAD_MS

  const add: TodoReminder[] = []
  const wanted = new Map<string, TodoReminder>()
  let retryAt: number | null = null
  for (const reminder of desired) {
    wanted.set(reminder.id, reminder)
    if (reminder.fireAt <= now + GUARD_AHEAD_MS) continue
    const current = pendingById.get(reminder.id)
    if (current && sameContent(current, reminder)) continue
    const trigger = current ? triggerOf(current) : null
    if (current && trigger !== null && inGuard(trigger)) {
      // Replacing it now would cancel a reminder that is arriving. Try again once it was delivered,
      // or, if macOS did not deliver it, once it has left the guard.
      const retry = trigger + DELIVERY_MS > now ? trigger + DELIVERY_MS : trigger + GUARD_BEHIND_MS + 1
      retryAt = retryAt === null ? retry : Math.min(retryAt, retry)
      continue
    }
    add.push(reminder)
  }

  const adding = new Set(add.map((reminder) => reminder.id))
  const remove: string[] = []
  for (const request of pendingById.values()) {
    if (adding.has(request.id) || inGuard(triggerOf(request))) continue
    const reminder = wanted.get(request.id)
    if (reminder && sameContent(request, reminder) && reminder.fireAt > now) continue
    remove.push(request.id)
  }
  return { add, remove, retryAt }
}
