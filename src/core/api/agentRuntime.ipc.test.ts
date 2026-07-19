import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { AgentRuntimeDay, AgentRuntimeEvidence } from '@common/domain'
import { Channel } from '@common/ipc'
import type { AgentRuntimeService } from '../agentRuntime/agentRuntimeService'
import { createAgentRuntimeHandlers, agentRuntimeWireRoutes } from './agentRuntime.ipc'

const day: AgentRuntimeDay = {
  localDate: '2026-07-06',
  minutes: 90,
  agents: 2,
  hasLowConfidence: false
}

const evidence: AgentRuntimeEvidence = {
  sessionId: 'ws1:tab1',
  localDate: '2026-07-06',
  minutes: 45,
  source: 'hook',
  confidence: 'high',
  projectId: 'p1',
  workItemSource: 'jira',
  workItemKey: 'FID-1',
  externalId: 'hook:ws1:tab1:2026-07-06',
  computedAt: 1
}

function makeService(over: Partial<AgentRuntimeService> = {}): AgentRuntimeService {
  return {
    recomputeSession: vi.fn(),
    recomputeAll: vi.fn(async () => {}),
    getWeek: vi.fn(() => [day]),
    getForProject: vi.fn(() => [day]),
    getForSession: vi.fn(() => [evidence]),
    refresh: vi.fn(async () => {}),
    ...over
  }
}

describe('agentRuntime handlers', () => {
  test('getWeek delegates with the week start', async () => {
    const service = makeService()
    const h = createAgentRuntimeHandlers({ service })
    expect((await h.getWeek('2026-07-06')).map((d) => d.minutes)).toEqual([90])
    expect(service.getWeek).toHaveBeenCalledWith('2026-07-06')
  })

  test('getForProject delegates project and week', async () => {
    const service = makeService()
    const h = createAgentRuntimeHandlers({ service })
    await h.getForProject('p1', '2026-07-06')
    expect(service.getForProject).toHaveBeenCalledWith('p1', '2026-07-06')
  })

  test('getForSession delegates the session id', async () => {
    const service = makeService()
    const h = createAgentRuntimeHandlers({ service })
    expect((await h.getForSession('ws1:tab1'))[0].externalId).toBe('hook:ws1:tab1:2026-07-06')
    expect(service.getForSession).toHaveBeenCalledWith('ws1:tab1')
  })

  test('refresh triggers a recompute', async () => {
    const service = makeService()
    const h = createAgentRuntimeHandlers({ service })
    await h.refresh()
    expect(service.refresh).toHaveBeenCalled()
  })

  test('wraps a thrown error as a message-only Error', async () => {
    const service = makeService({
      getWeek: vi.fn(() => {
        throw new Error('boom')
      })
    })
    const h = createAgentRuntimeHandlers({ service })
    await expect(h.getWeek('2026-07-06')).rejects.toThrow(/boom/)
  })
})

describe('agentRuntimeWireRoutes', () => {
  test('binds the four request/response channels to the handlers', async () => {
    const h = createAgentRuntimeHandlers({ service: makeService() })
    const routes = agentRuntimeWireRoutes(h)
    expect(Object.keys(routes).sort()).toEqual(
      [
        Channel.agentRuntimeGetWeek,
        Channel.agentRuntimeGetForProject,
        Channel.agentRuntimeGetForSession,
        Channel.agentRuntimeRefresh
      ].sort()
    )
    const week = (await (routes[Channel.agentRuntimeGetWeek] as (...a: unknown[]) => unknown)(
      '2026-07-06'
    )) as AgentRuntimeDay[]
    expect(week.map((d) => d.agents)).toEqual([2])
  })
})

/**
 * The whole point of this slice is that agent runtime is NOT a worklog and never uploads. This
 * guard reads the slice, service, and repo sources and asserts none of their CODE (comments,
 * which legitimately explain the separation, are stripped first) so much as names Toggl, a
 * worklog, an upload, or the human time_entry_* tables.
 */
describe('strict separation from Toggl and human worklogs', () => {
  const forbidden = /toggl|worklog|upload|time_entry_/i
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const here = __dirname
  const files = [
    join(here, 'agentRuntime.ipc.ts'),
    join(here, '..', 'agentRuntime', 'agentRuntimeService.ts'),
    join(here, '..', 'agentRuntime', 'activeMinutes.ts'),
    join(here, '..', 'db', 'agentRuntimeRepo.ts')
  ]

  for (const file of files) {
    test(`${file.split('/').slice(-1)[0]} exposes no toggl/worklog/upload/time_entry surface`, () => {
      expect(stripComments(readFileSync(file, 'utf8'))).not.toMatch(forbidden)
    })
  }
})
