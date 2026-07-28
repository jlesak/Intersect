import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { dayKeyOf } from '@common/week'
import { liveSessions, useAttentionStore } from '@renderer/features/attention'
import { useMyWorkStore } from '@renderer/features/myWork'
import { selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { useTimeTrackingStore } from '@renderer/features/timeTracking'
import { useTodoStore } from '@renderer/features/todo'
import { useUsageStore } from '@renderer/features/usage'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { useNow } from '@renderer/shared/ui/useNow'
import { actionPrs, deadlineTodos, isWeekend, loggedToday } from '../zones'
import { ZoneNeedsAction } from './ZoneNeedsAction'
import { ZoneSessions } from './ZoneSessions'
import { ZoneSystemStatus } from './ZoneSystemStatus'
import { ZoneTimeToday } from './ZoneTimeToday'

/** Everything on this surface is an age or a day figure, so the whole view shares one minute tick. */
const TICK_MS = 60_000

/**
 * The Dashboard: four zones in fixed positions answering "what needs me now", composed from data the
 * other slices already hold.
 *
 * This view owns three things and nothing else: the shared clock, the one hydrate that is not paid
 * at boot, and the memoized derivations feeding the zones. Every zone below takes plain props.
 *
 * The derivations are memoized here rather than selected from the stores on purpose. This is the
 * app's default landing view, so a selector that returned a fresh array or object would not merely
 * warn - the store factory throws, and the first thing the user would see is a crash.
 *
 * The clock also supplies the day key. Read once from `Date.now()` it would be correct at mount and
 * quietly wrong afterwards, so an app left open overnight would keep attributing today's work, and
 * today's deadlines, to yesterday.
 */
export function DashboardView() {
  const now = useNow(TICK_MS)
  const today = dayKeyOf(now)

  const prs = usePrInboxStore(useShallow(selectPrList))
  const prSyncedAt = usePrInboxStore((s) => s.syncedAt)
  const openTasks = useTodoStore((s) => s.open)
  const attention = useAttentionStore((s) => s.status)
  const workspacesById = useWorkspacesStore((s) => s.byId)
  const entries = useTimeTrackingStore((s) => s.entries)
  const weekStart = useTimeTrackingStore((s) => s.weekStart)
  const usage = useUsageStore((s) => s.usage)
  const jiraFetchedAt = useMyWorkStore((s) => s.fetchedAt)

  // The PR inbox, the task list, the Jira board and the usage snapshot are all hydrated at boot; the
  // worklog is not, and this is the first surface the user lands on. Guarded on idle so returning
  // here does not re-fetch a week that is already loaded.
  useEffect(() => {
    if (useTimeTrackingStore.getState().status === 'idle') {
      void useTimeTrackingStore.getState().hydrate()
    }
  }, [])

  const prRows = useMemo(() => actionPrs(prs), [prs])
  const deadlines = useMemo(() => deadlineTodos(openTasks, today), [openTasks, today])
  const sessions = useMemo(() => liveSessions(attention), [attention])
  const logged = useMemo(() => loggedToday(entries, weekStart, now), [entries, weekStart, now])

  return (
    <div className="ix-main">
      <div className="ix-dash">
        <div className="ix-dash__topbar">
          <div className="ix-dash__title">Mission control</div>
          <div className="ix-dash__subtitle">What needs you now</div>
        </div>

        <div className="ix-dash__grid">
          <ZoneNeedsAction prs={prRows} deadlines={deadlines} today={today} now={now} />
          <div className="ix-dash__stack">
            <ZoneSessions sessions={sessions} workspacesById={workspacesById} now={now} />
            <ZoneTimeToday loggedMs={logged} weekend={isWeekend(now)} />
            <ZoneSystemStatus
              usage={usage}
              jiraFetchedAt={jiraFetchedAt}
              prSyncedAt={prSyncedAt}
              now={now}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
