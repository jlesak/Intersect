import type { SessionTranscript, TimeEntryRef, TimeTrackingSettings } from '@common/domain'
import type { AppStateRepo } from '../db/appStateRepo'
import type { TimeOverrideRepo } from '../db/timeTrackingRepo'
import type { TimeSessionDay, TimeSessionDayRepo } from '../db/timeSessionDayRepo'
import type { SessionIndex } from '../sessions/sessionIndex'
import { insideAppData } from './exclusions'
import { TRACKING_ZONE_KEY } from './sessionSnapshots'
import { buildSummaryInput, type TimeSummaryResult } from './timeSummary'

const IDLE_MS = 30 * 60_000
const RETRY_PAUSE_MS = 30 * 60_000
const CHECK_MS = 10 * 60_000
const refKey = (row: Pick<TimeSessionDay, 'sessionId' | 'day'>) => `${row.sessionId}:${row.day}`
type AutoRef = Extract<TimeEntryRef, { source: 'auto' }>

export interface TimeSummarySchedulerDeps {
  snapshots: TimeSessionDayRepo
  overrides: TimeOverrideRepo
  sessions: Pick<SessionIndex, 'isResumable' | 'getTranscript'>
  scanner: { ready(): Promise<void> }
  state: Pick<AppStateRepo, 'get'>
  settings(): TimeTrackingSettings
  userDataDir: string
  now(): number
  summarize(input: string, signal: AbortSignal): Promise<TimeSummaryResult>
  changed(): void
  failed(code: string, sessionId: string, day: string): void
  getTranscript?(sessionId: string): Promise<SessionTranscript>
}

/** A single queue for scheduled and manual requests; no model promise can overlap another. */
export function createTimeSummaryScheduler(deps: TimeSummarySchedulerDeps) {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let flight: Promise<void> | null = null
  let active: AbortController | null = null
  let consecutiveFailures = 0
  let pausedUntil = 0
  const forced = new Set<string>()

  function eligible(row: TimeSessionDay, force: boolean): boolean {
    if (row.activeDurationMs < 300_000 || row.lastTimestamp <= 0) return false
    if (deps.overrides.get(row.sessionId, row.day)?.deleted) return false
    if (insideAppData(row.cwd, deps.userDataDir) ||
      deps.settings().excludedPathPrefixes.some(prefix => row.cwd.startsWith(prefix))) return false
    if (force) return true
    return deps.now() - row.lastTimestamp >= IDLE_MS &&
      (row.summary === null || row.summarizedThrough === null ||
        row.summarizedThrough < row.lastTimestamp)
  }

  async function process(row: TimeSessionDay, force: boolean): Promise<void> {
    if (!await deps.sessions.isResumable(row.sessionId) || disposed) return
    let input: string
    try {
      const transcript = await (deps.getTranscript ?? deps.sessions.getTranscript)(row.sessionId)
      if (disposed) return
      const current = deps.snapshots.get(row.sessionId, row.day)
      if (!current || current.lastTimestamp !== row.lastTimestamp || !eligible(current, force)) return
      const zone = deps.state.get(TRACKING_ZONE_KEY)
      if (!zone) return
      input = buildSummaryInput(current, transcript, zone)
      if (!input.includes('Uživatel:') && !input.includes('Asistent:')) return
    } catch {
      deps.failed('transcript-unavailable', row.sessionId, row.day)
      return
    }

    active = new AbortController()
    try {
      const result = await deps.summarize(input, active.signal)
      if (disposed) return
      const current = deps.snapshots.get(row.sessionId, row.day)
      if (!current || current.lastTimestamp !== row.lastTimestamp || !eligible(current, force) ||
        !await deps.sessions.isResumable(row.sessionId) || disposed) return
      if (deps.snapshots.saveSummary(row.sessionId, row.day, row.lastTimestamp, result)) {
        consecutiveFailures = 0
        deps.changed()
      }
    } catch {
      if (disposed) return
      const current = deps.snapshots.get(row.sessionId, row.day)
      if (current && current.lastTimestamp === row.lastTimestamp && eligible(current, force)) {
        deps.snapshots.failSummary(row.sessionId, row.day)
        deps.failed('model-failed', row.sessionId, row.day)
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) pausedUntil = deps.now() + RETRY_PAUSE_MS
      }
    } finally {
      active = null
    }
  }

  function tick(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (flight) return flight
    flight = (async () => {
      await deps.scanner.ready()
      const processed = new Set<string>()
      while (!disposed && deps.now() >= pausedUntil) {
        const rows = deps.snapshots.listAll()
        for (const key of forced) {
          if (!rows.some(row => refKey(row) === key && eligible(row, true))) forced.delete(key)
        }
        const next = rows.find(row => {
          const key = refKey(row)
          return !processed.has(key) && eligible(row, forced.has(key))
        })
        if (!next) break
        const key = refKey(next)
        const force = forced.delete(key)
        processed.add(key)
        await process(next, force)
      }
    })().catch(() => {
      // Scanner failures are reported by its own owner. The next interval will retry.
    }).finally(() => {
      flight = null
      // A manual request queued while its row was already in flight gets its own pass now.
      if (!disposed && forced.size > 0 && deps.now() >= pausedUntil) void tick()
    })
    return flight
  }

  return {
    tick,
    start() {
      if (disposed || timer) return
      void tick()
      timer = setInterval(() => { void tick() }, CHECK_MS)
      timer.unref?.()
    },
    async regenerate(ref: AutoRef): Promise<void> {
      const row = deps.snapshots.get(ref.sessionId, ref.day)
      if (!row || !eligible(row, true)) throw new Error('This card cannot be summarized')
      if (!await deps.sessions.isResumable(ref.sessionId)) {
        throw new Error('The session transcript is no longer available')
      }
      forced.add(refKey(row))
      void tick()
    },
    async confirmWork(ref: AutoRef): Promise<void> {
      const row = deps.snapshots.get(ref.sessionId, ref.day)
      if (!row || !eligible(row, true)) throw new Error('This card is not available')
      if (deps.snapshots.confirmWork(ref.sessionId, ref.day)) deps.changed()
    },
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
      active?.abort()
      forced.clear()
    }
  }
}
export type TimeSummaryScheduler = ReturnType<typeof createTimeSummaryScheduler>
