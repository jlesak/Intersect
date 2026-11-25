import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { TimeTrackingService } from '../timeTracking/timeTracking'
import type { TimeSummaryScheduler } from '../timeTracking/timeSummaryScheduler'

export interface TimeTrackingHandlerDeps {
  service: TimeTrackingService
  summary?: Pick<TimeSummaryScheduler, 'confirmWork' | 'regenerate'>
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Time tracking handlers: thin delegation to the {@link TimeTrackingService}, which owns the
 * merge of session-derived and manual entries. These handlers only bridge it to IPC and
 * normalize errors.
 */
export function createTimeTrackingHandlers(deps: TimeTrackingHandlerDeps): Omit<IpcApi['timeTracking'], 'onChanged'> {
  return {
    getWeek: (weekStart) => surface(() => deps.service.getWeek(weekStart)),
    refreshWeek: (weekStart) => surface(() => deps.service.refreshWeek(weekStart)),
    addManual: (input) => surface(async () => deps.service.addManual(input)),
    updateEntry: (ref, update) => surface(() => deps.service.updateEntry(ref, update)),
    deleteEntry: (ref) => surface(() => deps.service.deleteEntry(ref)),
    confirmWork: (ref) => surface(() => {
      if (!deps.summary) throw new Error('Summary service unavailable')
      return deps.summary.confirmWork(ref)
    }),
    regenerate: (ref) => surface(() => {
      if (!deps.summary) throw new Error('Summary service unavailable')
      return deps.summary.regenerate(ref)
    }),
    getTimer: () => surface(async () => deps.service.getRunningTimer()),
    startTimer: (description, issueKey) =>
      surface(async () => deps.service.startTimer(description, issueKey)),
    updateTimer: (description, issueKey) =>
      surface(async () => deps.service.updateTimer(description, issueKey)),
    stopTimer: () => surface(async () => deps.service.stopTimer())
  }
}

export function timeTrackingWireRoutes(h: Omit<IpcApi['timeTracking'], 'onChanged'>): WireRoutes {
  return {
    [Channel.timeTrackingGetWeek]: h.getWeek,
    [Channel.timeTrackingRefreshWeek]: h.refreshWeek,
    [Channel.timeTrackingAddManual]: h.addManual,
    [Channel.timeTrackingUpdateEntry]: h.updateEntry,
    [Channel.timeTrackingDeleteEntry]: h.deleteEntry,
    [Channel.timeTrackingConfirmWork]: h.confirmWork,
    [Channel.timeTrackingRegenerate]: h.regenerate,
    [Channel.timeTrackingGetTimer]: h.getTimer,
    [Channel.timeTrackingStartTimer]: h.startTimer,
    [Channel.timeTrackingUpdateTimer]: h.updateTimer,
    [Channel.timeTrackingStopTimer]: h.stopTimer
  }
}
