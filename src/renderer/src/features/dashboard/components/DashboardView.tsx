import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { dayKeyOf } from '@common/week'
import { liveSessions, useAttentionStore } from '@renderer/features/attention'
import { useMyWorkStore } from '@renderer/features/myWork'
import { selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { useSettingsStore } from '@renderer/features/settings'
import { useTimeTrackingStore } from '@renderer/features/timeTracking'
import { useTodoStore } from '@renderer/features/todo'
import { useUsageStore } from '@renderer/features/usage'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { useNow } from '@renderer/shared/ui/useNow'
import { actionPrs, adoSetup, deadlineTodos, emptyState, timeToday } from '../zones'
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
  const prStatus = usePrInboxStore((s) => s.status)
  const prSyncedAt = usePrInboxStore((s) => s.syncedAt)
  const openTasks = useTodoStore((s) => s.open)
  const todoStatus = useTodoStore((s) => s.status)
  const attention = useAttentionStore((s) => s.status)
  const workspacesById = useWorkspacesStore((s) => s.byId)
  const entries = useTimeTrackingStore((s) => s.entries)
  const weekStart = useTimeTrackingStore((s) => s.weekStart)
  const timeStatus = useTimeTrackingStore((s) => s.status)
  const usage = useUsageStore((s) => s.usage)
  const jiraFetchedAt = useMyWorkStore((s) => s.fetchedAt)
  const settingsStatus = useSettingsStore((s) => s.status)
  const ado = useSettingsStore((s) => s.ado)
  const adoFallback = useSettingsStore((s) => s.adoFallback)

  // The PR inbox, the task list, the Jira board and the usage snapshot are all hydrated at boot; the
  // worklog is not, and this is the first surface the user lands on. A week already loaded is left
  // alone; a week whose read failed is read again, because hydrate is spent after its first attempt
  // and the zone would otherwise carry that failure for the rest of the session.
  useEffect(() => {
    const store = useTimeTrackingStore.getState()
    if (store.status === 'idle') void store.hydrate()
    else if (store.status === 'error') void store.loadWeek(store.weekStart)
  }, [])

  const prRows = useMemo(() => actionPrs(prs), [prs])
  const deadlines = useMemo(() => deadlineTodos(openTasks, today), [openTasks, today])
  const sessions = useMemo(() => liveSessions(attention), [attention])
  const time = useMemo(
    () => timeToday(entries, weekStart, timeStatus, now),
    [entries, weekStart, timeStatus, now]
  )
  // Both surfaces reading Azure DevOps - the zone 1 subgroup and the zone 4 freshness row - answer
  // from the same signal, so a fresh profile cannot read as set up in one place and not the other.
  const prSetup = adoSetup(settingsStatus, ado, adoFallback)

  return (
    <div className="ix-main">
      <div className="ix-dash">
        <div className="ix-dash__topbar">
          <div className="ix-dash__title">Mission control</div>
          <div className="ix-dash__subtitle">What needs you now</div>
        </div>

        <div className="ix-dash__grid">
          <ZoneNeedsAction
            prs={prRows}
            prState={emptyState(prStatus, prSetup)}
            deadlines={deadlines}
            deadlineState={emptyState(todoStatus)}
            today={today}
            now={now}
          />
          <div className="ix-dash__stack">
            <ZoneSessions sessions={sessions} workspacesById={workspacesById} now={now} />
            <ZoneTimeToday state={time} />
            <ZoneSystemStatus
              usage={usage}
              jiraFetchedAt={jiraFetchedAt}
              prSyncedAt={prSyncedAt}
              prSetup={prSetup}
              now={now}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
