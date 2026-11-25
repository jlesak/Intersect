import type { CalendarMeeting, MeetingRoutingSettings, MeetingSnapshot } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { validJoinUrl } from '@common/meetingJoin'
import type { AppStateRepo } from '../db/appStateRepo'
import type { MeetingProposals } from '../timeTracking/meetingProposals'

const CACHE_KEY = 'meetings.today.cache'
const FETCH_TIMEOUT_MS = 45_000
const CACHED_DAYS = 2

/** Validate the one report from the hidden calendar session before it reaches cache or UI. */
export function normalizeCalendarReport(input: unknown, day: string): CalendarMeeting[] {
  if (!Array.isArray(input)) throw new Error('Calendar report must contain an event list')
  if (input.length > 500) throw new Error('Calendar report contains too many events')
  const events: CalendarMeeting[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    const id = typeof event.id === 'string' ? event.id.trim() : ''
    const subject = typeof event.subject === 'string' ? event.subject.trim() : ''
    const startAt = typeof event.start === 'string' ? Date.parse(event.start) : NaN
    const endAt = typeof event.end === 'string' ? Date.parse(event.end) : NaN
    if (!id || id.length > 500 || !subject || subject.length > 1000 || seen.has(id) ||
      !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt ||
      endAt - startAt > 24 * 60 * 60_000 || dayKeyOf(startAt) !== day) continue
    seen.add(id)
    // Cancelled and declined appointments are no longer scheduled for the owner. All-day items
    // remain visible on the Dashboard but do not produce time proposals.
    if (event.isCancelled === true || event.response === 'declined') continue
    const online = event.onlineMeeting && typeof event.onlineMeeting === 'object'
      ? event.onlineMeeting as Record<string, unknown> : null
    events.push({
      source: 'microsoft365', externalId: id, day, subject, startAt, endAt,
      joinUrl: validJoinUrl(online?.joinUrl), cancelled: false, declined: false,
      allDay: event.isAllDay === true
    })
  }
  return events.sort((a, b) => a.startAt - b.startAt || a.externalId.localeCompare(b.externalId))
}

export interface MeetingsDeps {
  state: AppStateRepo
  proposals: MeetingProposals
  routing(): MeetingRoutingSettings
  fetch(day: string, signal: AbortSignal): Promise<unknown>
  now(): number
  atomically<T>(fn: () => T): T
}

export interface MeetingsService {
  get(day: string): MeetingSnapshot
  open(day: string): Promise<MeetingSnapshot>
  refresh(day: string): Promise<MeetingSnapshot>
  rerouteCached(routing: MeetingRoutingSettings): void
}

export function createMeetings(deps: MeetingsDeps): MeetingsService {
  const attemptedDays = new Set<string>()
  const inFlight = new Map<string, Promise<MeetingSnapshot>>()
  const errors = new Map<string, string>()

  function cachedDays(): Record<string, unknown> {
    try {
      const saved = deps.state.get(CACHE_KEY)
      const value: unknown = saved ? JSON.parse(saved) : null
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // A corrupt local cache is equivalent to no cache. The next refresh replaces it.
    }
    return {}
  }

  function get(day: string): MeetingSnapshot {
    const value = cachedDays()[day]
    if (value && typeof value === 'object') {
      const snapshot = value as Record<string, unknown>
      if (typeof snapshot.syncedAt === 'number' && Number.isFinite(snapshot.syncedAt) &&
        Array.isArray(snapshot.meetings)) {
        return { day, syncedAt: snapshot.syncedAt,
          meetings: (snapshot.meetings as CalendarMeeting[]).filter((meeting) =>
            meeting?.day === day && dayKeyOf(meeting.startAt) === day),
          error: errors.get(day) ?? null }
      }
    }
    return { day, syncedAt: null, meetings: [], error: errors.get(day) ?? null }
  }

  async function fetchWithTimeout(day: string): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        deps.fetch(day, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Calendar refresh timed out'))
          }, FETCH_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function refresh(day: string): Promise<MeetingSnapshot> {
    const current = inFlight.get(day)
    if (current) return current
    attemptedDays.add(day)
    const request = (async () => {
      try {
        const meetings = normalizeCalendarReport(await fetchWithTimeout(day), day)
        const syncedAt = deps.now()
        deps.atomically(() => {
          const days = { ...cachedDays(), [day]: { syncedAt, meetings } }
          const newest = Object.keys(days).sort().reverse().slice(0, CACHED_DAYS)
          deps.state.set(CACHE_KEY, JSON.stringify(Object.fromEntries(
            newest.map((key) => [key, days[key]])
          )))
          deps.proposals.reconcile(day, meetings, deps.routing())
        })
        errors.delete(day)
      } catch (error) {
        errors.set(day, error instanceof Error ? error.message : String(error))
      }
      return get(day)
    })()
    inFlight.set(day, request)
    void request.finally(() => inFlight.delete(day))
    return request
  }

  return {
    get,
    open(day) { return attemptedDays.has(day) ? inFlight.get(day) ?? Promise.resolve(get(day)) : refresh(day) },
    refresh,
    rerouteCached(routing) {
      deps.atomically(() => {
        for (const day of Object.keys(cachedDays())) {
          const snapshot = get(day)
          if (snapshot.syncedAt !== null) deps.proposals.reconcile(day, snapshot.meetings, routing)
        }
      })
    }
  }
}
