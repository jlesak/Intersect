import type { CalendarMeeting, MeetingProposal, MeetingSnapshot } from '@common/domain'
import { validJoinUrl } from '@common/meetingJoin'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './meetingsIpc'
import { useTimeTrackingStore } from './store'

interface MeetingsState {
  snapshot: MeetingSnapshot | null
  proposals: MeetingProposal[]
  loading: boolean
  load(day: string): Promise<void>
  loadProposals(day: string): Promise<void>
  refresh(day: string): Promise<void>
  accept(proposal: MeetingProposal): Promise<void>
  acceptAll(day: string): Promise<void>
  decline(proposal: MeetingProposal): Promise<void>
  join(event: CalendarMeeting): Promise<void>
}

export const useMeetingsStore = createStore<MeetingsState>()((set) => {
  let request = 0
  let proposalRequest = 0
  async function proposals(day: string): Promise<void> {
    const id = ++proposalRequest
    try {
      const rows = await api.listProposals(day)
      if (id === proposalRequest) set({ proposals: rows })
    } catch (error) {
      if (id === proposalRequest) reportError('Could not load meeting proposals', error)
    }
  }
  return {
    snapshot: null,
    proposals: [],
    loading: false,
    async load(day) {
      const id = ++request
      ++proposalRequest
      set({ loading: true, proposals: [] })
      try {
        const cache = await api.get(day)
        if (id !== request) return
        set({ snapshot: cache })
        await proposals(day)
        const fresh = await api.open(day)
        if (id !== request) return
        set({ snapshot: fresh })
        await proposals(day)
      } catch (error) {
        if (id === request) reportError('Could not load meetings', error)
      } finally { if (id === request) set({ loading: false }) }
    },
    loadProposals: proposals,
    async refresh(day) {
      const id = ++request
      set({ loading: true })
      try {
        const snapshot = await api.refresh(day)
        if (id !== request) return
        set({ snapshot })
        await proposals(day)
      } catch (error) {
        if (id === request) reportError('Could not refresh meetings', error)
      } finally { if (id === request) set({ loading: false }) }
    },
    async accept(proposal) {
      try {
        await api.accept(proposal.source, proposal.externalId)
        await proposals(proposal.day)
        await useTimeTrackingStore.getState().reload()
      } catch (error) { reportError('Could not accept the meeting', error) }
    },
    async acceptAll(day) {
      try {
        await api.acceptAll(day)
        await proposals(day)
        await useTimeTrackingStore.getState().reload()
      } catch (error) { reportError('Could not accept meetings', error) }
    },
    async decline(proposal) {
      try {
        await api.decline(proposal.source, proposal.externalId)
        await proposals(proposal.day)
      } catch (error) { reportError('Could not decline the meeting', error) }
    },
    async join(event) {
      const url = validJoinUrl(event.joinUrl)
      if (!url) return
      try { await api.openExternal(url) }
      catch (error) { reportError('Could not open the meeting', error) }
    }
  }
})
