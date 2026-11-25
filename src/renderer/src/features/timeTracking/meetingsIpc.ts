import type { CalendarMeeting, MeetingProposal, MeetingSnapshot, TimeEntry } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

export const get = (day: string): Promise<MeetingSnapshot> => ipc().meetings.get(day)
export const open = (day: string): Promise<MeetingSnapshot> => ipc().meetings.open(day)
export const refresh = (day: string): Promise<MeetingSnapshot> => ipc().meetings.refresh(day)
export const listProposals = (day: string): Promise<MeetingProposal[]> =>
  ipc().meetings.listProposals(day)
export const accept = (source: CalendarMeeting['source'], externalId: string): Promise<TimeEntry | null> =>
  ipc().meetings.accept(source, externalId)
export const acceptAll = (day: string): Promise<TimeEntry[]> => ipc().meetings.acceptAll(day)
export const decline = (source: CalendarMeeting['source'], externalId: string): Promise<void> =>
  ipc().meetings.decline(source, externalId)
export const openExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
