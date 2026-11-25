import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MeetingProposal, MeetingSnapshot } from '@common/domain'
vi.mock('./meetingsIpc')
import * as api from './meetingsIpc'
import { useMeetingsStore } from './meetingsStore'

const mocked = vi.mocked(api)
const snapshot = (day: string): MeetingSnapshot => ({ day, syncedAt: null, meetings: [], error: null })
const proposal = (day: string): MeetingProposal => ({
  source: 'microsoft365', externalId: day, day, description: 'Sync', startAt: 1,
  durationMs: 1800000, issueKey: null, projectId: null
})

beforeEach(() => {
  vi.resetAllMocks()
  useMeetingsStore.setState({ snapshot: null, proposals: [], loading: false })
  mocked.get.mockImplementation(async (day) => snapshot(day))
  mocked.open.mockImplementation(async (day) => snapshot(day))
})

describe('meetings store day rollover', () => {
  test('a late prior-day proposal response cannot replace today’s proposals', async () => {
    let finishOld!: (rows: MeetingProposal[]) => void
    mocked.listProposals.mockImplementation((day) => day === '2026-11-25'
      ? new Promise((resolve) => { finishOld = resolve }) : Promise.resolve([proposal(day)]))
    const old = useMeetingsStore.getState().load('2026-11-25')
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'))
    const today = useMeetingsStore.getState().load('2026-11-26')
    await today
    finishOld([proposal('2026-11-25')])
    await old
    expect(useMeetingsStore.getState().proposals.map((p) => p.day)).toEqual(['2026-11-26'])
  })
})
