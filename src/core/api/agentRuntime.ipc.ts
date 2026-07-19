import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { AgentRuntimeService } from '../agentRuntime/agentRuntimeService'

export interface AgentRuntimeHandlerDeps {
  service: AgentRuntimeService
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => Promise<T> | T): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Agent runtime evidence handlers: thin delegation to the {@link AgentRuntimeService}, which owns
 * the derivation and the strict separation from human worklogs. There is deliberately no method
 * here that writes a worklog or touches Toggl - this slice only reads evidence and triggers a
 * recompute.
 */
export function createAgentRuntimeHandlers(deps: AgentRuntimeHandlerDeps): IpcApi['agentRuntime'] {
  return {
    getWeek: (weekStart) => surface(() => deps.service.getWeek(weekStart)),
    getForProject: (projectId, weekStart) =>
      surface(() => deps.service.getForProject(projectId, weekStart)),
    getForSession: (sessionId) => surface(() => deps.service.getForSession(sessionId)),
    refresh: () => surface(() => deps.service.refresh())
  }
}

export function agentRuntimeWireRoutes(h: IpcApi['agentRuntime']): WireRoutes {
  return {
    [Channel.agentRuntimeGetWeek]: h.getWeek,
    [Channel.agentRuntimeGetForProject]: h.getForProject,
    [Channel.agentRuntimeGetForSession]: h.getForSession,
    [Channel.agentRuntimeRefresh]: h.refresh
  }
}
