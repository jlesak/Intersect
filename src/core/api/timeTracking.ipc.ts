import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { TimeTrackingService } from '../timeTracking/timeTracking'

export interface TimeTrackingHandlerDeps {
  service: TimeTrackingService
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
export function createTimeTrackingHandlers(deps: TimeTrackingHandlerDeps): IpcApi['timeTracking'] {
  return {
    getWeek: (weekStart) => surface(() => deps.service.getWeek(weekStart)),
    refreshWeek: (weekStart) => surface(() => deps.service.refreshWeek(weekStart)),
    addManual: (input) => surface(async () => deps.service.addManual(input)),
    updateEntry: (source, id, update) => surface(() => deps.service.updateEntry(source, id, update)),
    deleteEntry: (source, id) => surface(() => deps.service.deleteEntry(source, id))
  }
}

export function timeTrackingWireRoutes(h: IpcApi['timeTracking']): WireRoutes {
  return {
    [Channel.timeTrackingGetWeek]: h.getWeek,
    [Channel.timeTrackingRefreshWeek]: h.refreshWeek,
    [Channel.timeTrackingAddManual]: h.addManual,
    [Channel.timeTrackingUpdateEntry]: h.updateEntry,
    [Channel.timeTrackingDeleteEntry]: h.deleteEntry
  }
}
