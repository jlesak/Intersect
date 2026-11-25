import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { MeetingsService } from '../meetings/meetings'
import type { MeetingProposals } from '../timeTracking/meetingProposals'

export function createMeetingsHandlers(deps: {
  meetings: MeetingsService
  proposals: MeetingProposals
  changed(): void
}): IpcApi['meetings'] {
  return {
    get: async (day) => deps.meetings.get(day),
    open: (day) => deps.meetings.open(day),
    refresh: (day) => deps.meetings.refresh(day),
    listProposals: async (day) => deps.proposals.list(day),
    accept: async (source, externalId) => {
      const entry = deps.proposals.accept(source, externalId)
      if (entry) deps.changed()
      return entry
    },
    acceptAll: async (day) => {
      const entries = deps.proposals.acceptAll(day)
      if (entries.length) deps.changed()
      return entries
    },
    decline: async (source, externalId) => deps.proposals.decline(source, externalId)
  }
}

export function meetingsWireRoutes(h: IpcApi['meetings']): WireRoutes {
  return {
    [Channel.meetingsGet]: h.get,
    [Channel.meetingsOpen]: h.open,
    [Channel.meetingsRefresh]: h.refresh,
    [Channel.meetingsListProposals]: h.listProposals,
    [Channel.meetingsAccept]: h.accept,
    [Channel.meetingsAcceptAll]: h.acceptAll,
    [Channel.meetingsDecline]: h.decline
  }
}
