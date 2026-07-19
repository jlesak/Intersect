import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { AgentToolingScope } from '@common/domain'
import type { ClaudeConfigReader, ResolvedScope } from '../agentTooling/claudeConfigReader'
import type { ConfigWriter } from '../agentTooling/configWriter'

export interface AgentToolingHandlerDeps {
  reader: ClaudeConfigReader
  /** The guarded writer serving preview / commit / undo, over its own read + write seams. */
  writer: ConfigWriter
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
 * Agent Tooling handlers: the read-only browse over the {@link ClaudeConfigReader} plus the
 * guarded mutation pipeline over the {@link ConfigWriter}. Every request resolves the renderer
 * scope to its repository allowlist before delegating. The write handlers never touch a file
 * outside that allowlist, never write on preview, and reject a stale-revision commit.
 */
export function createAgentToolingHandlers(deps: AgentToolingHandlerDeps): IpcApi['agentTooling'] {
  return {
    getEffectiveConfig: (scope) =>
      surface(() => {
        const resolved = deps.reader.getEffectiveConfig(deps.resolveScope(scope))
        return { scope, adapter: 'claude-code' as const, ...resolved }
      }),
    listSkills: (scope) => surface(() => deps.reader.listSkills(deps.resolveScope(scope))),
    listAgents: (scope) => surface(() => deps.reader.listAgents(deps.resolveScope(scope))),
    readRaw: (scope, source) =>
      surface(() => ({ scope, ...deps.writer.readTarget(deps.resolveScope(scope), source) })),
    previewSave: (req) =>
      surface(() => ({
        scope: req.scope,
        ...deps.writer.preview(deps.resolveScope(req.scope), req.source, req.edit)
      })),
    commitSave: (req) =>
      surface(() =>
        deps.writer.save(deps.resolveScope(req.scope), req.source, req.edit, req.revision)
      ),
    undoSave: (targetPath) => surface(() => deps.writer.undo(targetPath))
  }
}

export function agentToolingWireRoutes(h: IpcApi['agentTooling']): WireRoutes {
  return {
    [Channel.agentToolingGetEffectiveConfig]: h.getEffectiveConfig,
    [Channel.agentToolingListSkills]: h.listSkills,
    [Channel.agentToolingListAgents]: h.listAgents,
    [Channel.agentToolingReadRaw]: h.readRaw,
    [Channel.agentToolingPreviewSave]: h.previewSave,
    [Channel.agentToolingCommitSave]: h.commitSave,
    [Channel.agentToolingUndoSave]: h.undoSave
  }
}
