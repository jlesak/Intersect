import type { TimeTrackingSettings } from '@common/domain'
import type { AppStateRepo } from '../db/appStateRepo'
import type { TimeSessionDayRepo } from '../db/timeSessionDayRepo'
import type { SessionIndex } from '../sessions/sessionIndex'
import { activityByDay, trackingDayKey } from './dayActivity'
import { insideAppData } from './exclusions'
import { autoDescription } from './worklogDescription'

export const SNAPSHOT_INTERVAL_MS = 600_000
export const TRACKING_ZONE_KEY = 'timeTracking.timeZone'
export interface SessionSnapshotDeps {
  sessions: SessionIndex
  snapshots: TimeSessionDayRepo
  state: AppStateRepo
  settings(): TimeTrackingSettings
  userDataDir: string
  atomically: <T>(fn: () => T) => T
  changed(): void
  failed(error: unknown): void
  systemTimeZone?: () => string
}

/** Owns one scan at a time and never keeps a DB transaction open over filesystem awaits. */
export function createSessionSnapshots(deps: SessionSnapshotDeps) {
  let disposed = false
  let flight: Promise<void> | null = null
  let initial: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let lastSettings = ''
  let initialized = false

  function scan(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (flight) return flight
    // Capture the zone before awaiting, but persist it together with the first successful scan.
    const zone = deps.state.get(TRACKING_ZONE_KEY) ??
      (deps.systemTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    flight = (async () => {
      const observed = await deps.sessions.scan()
      if (disposed) return
      const dayKey = trackingDayKey(zone)
      // Settings are read at commit time. Reads also filter using the current saved settings.
      const settings = JSON.stringify(deps.settings())
      let changed = settings !== lastSettings
      deps.atomically(() => {
        if (!deps.state.get(TRACKING_ZONE_KEY)) deps.state.set(TRACKING_ZONE_KEY, zone)
        for (const { summary, timestamps } of observed) {
          if (insideAppData(summary.cwd, deps.userDataDir)) continue
          for (const day of activityByDay(timestamps, dayKey)) {
            changed = deps.snapshots.upsert({ ...day, sessionId: summary.id, title: summary.title,
              cwd: summary.cwd, gitBranch: summary.gitBranch, autoDescription: autoDescription(summary)
            }) || changed
          }
          if (summary.lastTimestamp > 0) {
            changed = deps.snapshots.adoptLegacy(summary.id, dayKey(summary.lastTimestamp)) || changed
          }
        }
      })
      initialized = true
      lastSettings = settings
      if (!disposed && changed) deps.changed()
    })().finally(() => { flight = null })
    return flight
  }

  function background(): Promise<void> {
    return scan().catch(error => { if (!disposed) deps.failed(error) })
  }

  return {
    scan,
    start() {
      if (disposed || initial) return
      initial = background()
      timer = setInterval(() => { void background() }, SNAPSHOT_INTERVAL_MS)
      timer.unref?.()
    },
    async ready() {
      if (initialized || disposed) return
      if (!initial) initial = background()
      await initial
    },
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
    }
  }
}
export type SessionSnapshots = ReturnType<typeof createSessionSnapshots>
