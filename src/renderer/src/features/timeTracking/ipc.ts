import type {
  NewManualTimeEntry,
  RunningTimer,
  TimeEntry,
  TimeEntrySource,
  TimeEntryUpdate
} from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the time tracking store and the preload bridge.
export const getWeek = (weekStart: string): Promise<TimeEntry[]> =>
  ipc().timeTracking.getWeek(weekStart)
export const refreshWeek = (weekStart: string): Promise<TimeEntry[]> =>
  ipc().timeTracking.refreshWeek(weekStart)
export const addManual = (input: NewManualTimeEntry): Promise<TimeEntry> =>
  ipc().timeTracking.addManual(input)
export const updateEntry = (
  source: TimeEntrySource,
  id: string,
  update: TimeEntryUpdate
): Promise<TimeEntry> => ipc().timeTracking.updateEntry(source, id, update)
export const deleteEntry = (source: TimeEntrySource, id: string): Promise<void> =>
  ipc().timeTracking.deleteEntry(source, id)
export const getTimer = (): Promise<RunningTimer | null> => ipc().timeTracking.getTimer()
export const startTimer = (description: string, issueKey: string | null): Promise<RunningTimer> =>
  ipc().timeTracking.startTimer(description, issueKey)
export const updateTimer = (description: string, issueKey: string | null): Promise<RunningTimer> =>
  ipc().timeTracking.updateTimer(description, issueKey)
export const stopTimer = (): Promise<TimeEntry | null> => ipc().timeTracking.stopTimer()
