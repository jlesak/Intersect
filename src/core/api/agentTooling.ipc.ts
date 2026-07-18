import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { AgentToolingScope } from '@common/domain'
import type { ClaudeConfigReader, ResolvedScope } from '../agentTooling/claudeConfigReader'

export interface AgentToolingHandlerDeps {
  reader: ClaudeConfigReader
  /**
   * Translate a renderer scope into the reader's resolved scope. Global scope passes through;
   * project scope resolves the Project id to its canonical repository roots (the containment
   * allowlist) and throws a readable error for an unknown project.
   */
  resolveScope(scope: AgentToolingScope): ResolvedScope
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => T | Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Agent Tooling handlers: a thin, read-only bridge over the {@link ClaudeConfigReader}. Every
 * request resolves the renderer scope to its repository allowlist, then delegates. No handler
 * writes anything - this slice only ever reads Claude's configuration and catalogs.
 */
export function createAgentToolingHandlers(deps: AgentToolingHandlerDeps): IpcApi['agentTooling'] {
  return {
    getEffectiveConfig: (scope) =>
      surface(() => {
        const resolved = deps.reader.getEffectiveConfig(deps.resolveScope(scope))
        return { scope, adapter: 'claude-code' as const, ...resolved }
      }),
    listSkills: (scope) => surface(() => deps.reader.listSkills(deps.resolveScope(scope))),
    listAgents: (scope) => surface(() => deps.reader.listAgents(deps.resolveScope(scope)))
  }
}

export function agentToolingWireRoutes(h: IpcApi['agentTooling']): WireRoutes {
  return {
    [Channel.agentToolingGetEffectiveConfig]: h.getEffectiveConfig,
    [Channel.agentToolingListSkills]: h.listSkills,
    [Channel.agentToolingListAgents]: h.listAgents
  }
}
