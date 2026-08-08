import { dayKeyOf } from '@common/week'
import { registerCapture } from '@renderer/shared/registries/captureRegistry'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconClock } from '@renderer/shared/ui/icons'
import { SidebarTimeTracking } from './components/SidebarTimeTracking'
import { TimeTrackingView } from './components/TimeTrackingView'
import { useToastStore } from '@renderer/shared/ui/toast'
import { parseTimeCapture } from './captureInput'
import { formatTotal, loggedEntryNotice } from './time'
import { useTimeTrackingStore } from './store'
import { useAgentRuntimeStore } from './agentRuntimeStore'

/**
 * Registers the Time Tracking sidebar section (owning the main area), its refresh command, and the
 * `time:` quick capture. A captured span is always logged to today: the point of capturing one is
 * that the work just happened.
 */
export function registerTimeTrackingFeature(): void {
  registerSidebarSection({
    id: 'timeTracking',
    order: 12,
    label: 'Time Tracking',
    icon: IconClock,
    component: SidebarTimeTracking,
    mainComponent: TimeTrackingView
  })
  registerCommand({
    id: 'timeTracking.refresh',
    title: 'Refresh Time Tracking',
    group: 'Refresh',
    keywords: ['worklog', 'hours', 'timesheet', 'sync', 'reload'],
    handler: async () => {
      // Refresh the worklog board and the agent-runtime supporting figures together.
      await Promise.all([
        useTimeTrackingStore.getState().refresh(),
        useAgentRuntimeStore.getState().refresh()
      ])
    }
  })
  registerCapture({
    prefix: 'time:',
    hint: 'Log time - "time: 30m FID-123 sprint review"',
    preview(rest) {
      const parsed = parseTimeCapture(rest)
      if (!parsed) return null
      const against = parsed.issueKey ?? 'no issue'
      const what = parsed.description === '' ? '' : `: ${parsed.description}`
      return `Log ${formatTotal(parsed.durationMs)} today against ${against}${what}`
    },
    async run(rest) {
      const parsed = parseTimeCapture(rest)
      if (!parsed) return
      const day = dayKeyOf(Date.now())
      // The board is not on screen to contradict a false confirmation, so the store has to say
      // whether the entry was really written. A failure has already raised its own message.
      const written = await useTimeTrackingStore.getState().addManual({
        day,
        description: parsed.description,
        issueKey: parsed.issueKey,
        durationMs: parsed.durationMs
      })
      if (!written) return
      // Captured from wherever the user was, the board is not on screen to show the new card, so
      // the entry has to say it landed. A span written to a weekend borrows the timer's wording
      // for the same reason it exists: the weekday board will not show it.
      const against = parsed.issueKey === null ? '' : ` to ${parsed.issueKey}`
      useToastStore
        .getState()
        .push(
          loggedEntryNotice({ day, durationMs: parsed.durationMs, issueKey: parsed.issueKey }) ??
            `Logged ${formatTotal(parsed.durationMs)}${against}.`
        )
    }
  })
}
