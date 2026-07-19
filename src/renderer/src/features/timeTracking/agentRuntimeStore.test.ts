import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentRuntimeDay } from '@common/domain'

vi.mock('./agentRuntimeIpc')
import * as api from './agentRuntimeIpc'
import { useAgentRuntimeStore } from './agentRuntimeStore'

const mocked = vi.mocked(api)

const day = (over: Partial<AgentRuntimeDay> = {}): AgentRuntimeDay => ({
  localDate: '2026-07-06',
  minutes: 90,
  agents: 2,
  hasLowConfidence: false,
  ...over
})

beforeEach(() => {
  useAgentRuntimeStore.setState({ weekStart: null, byDay: {} }, false)
  vi.clearAllMocks()
})

describe('agentRuntimeStore', () => {
  test('loadWeek indexes the days by local date', async () => {
    mocked.getWeek.mockResolvedValue([day(), day({ localDate: '2026-07-07', agents: 1 })])
    await useAgentRuntimeStore.getState().loadWeek('2026-07-06')
    const byDay = useAgentRuntimeStore.getState().byDay
    expect(byDay['2026-07-06'].agents).toBe(2)
    expect(byDay['2026-07-07'].agents).toBe(1)
    expect(mocked.getWeek).toHaveBeenCalledWith('2026-07-06')
  })

  test('a failed load degrades to no figures rather than an error', async () => {
    mocked.getWeek.mockRejectedValue(new Error('core down'))
    await useAgentRuntimeStore.getState().loadWeek('2026-07-06')
    expect(useAgentRuntimeStore.getState().byDay).toEqual({})
  })

  test('a stale response for a week no longer shown is dropped', async () => {
    let resolveFirst: (d: AgentRuntimeDay[]) => void = () => {}
    mocked.getWeek.mockImplementationOnce(
      () => new Promise((r) => (resolveFirst = r))
    )
    mocked.getWeek.mockResolvedValueOnce([day({ localDate: '2026-07-13', agents: 5 })])

    const first = useAgentRuntimeStore.getState().loadWeek('2026-07-06')
    await useAgentRuntimeStore.getState().loadWeek('2026-07-13')
    resolveFirst([day({ localDate: '2026-07-06', agents: 99 })])
    await first

    // The store shows the current week (13th), not the late first response.
    expect(useAgentRuntimeStore.getState().byDay['2026-07-06']).toBeUndefined()
    expect(useAgentRuntimeStore.getState().byDay['2026-07-13'].agents).toBe(5)
  })

  test('refresh triggers a core recompute then reloads the shown week', async () => {
    mocked.getWeek.mockResolvedValue([day()])
    await useAgentRuntimeStore.getState().loadWeek('2026-07-06')
    mocked.refresh.mockResolvedValue(undefined)
    mocked.getWeek.mockResolvedValue([day({ agents: 3 })])
    await useAgentRuntimeStore.getState().refresh()
    expect(mocked.refresh).toHaveBeenCalled()
    expect(useAgentRuntimeStore.getState().byDay['2026-07-06'].agents).toBe(3)
  })
})
