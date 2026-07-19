import type { DatabaseSync } from 'node:sqlite'
import { type WireRoutes } from '@common/coreBridge'
import type { LiveClaudeSession } from '@common/domain'
import { Channel, parseSessionId, type IpcApi } from '@common/ipc'
import type { SessionIndex } from '../sessions/sessionIndex'
import type { SessionLifecycleService } from '../hooks/sessionLifecycleService'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'

export interface SessionHandlerDeps {
  index: SessionIndex
  /** The in-memory lifecycle tracking whose live set the quit modal reads. */
  lifecycle: SessionLifecycleService
  tabs: TabRepo
  workspaces: WorkspaceRepo
  db: DatabaseSync
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Session handlers: the read-only search index delegation, plus the suspend/resume surface. The
 * live list joins the canonical in-memory lifecycle tracking with the persisted tab/workspace names
 * so the quit modal in Electron main can name each running session without duplicating core state.
 */
export function createSessionHandlers(deps: SessionHandlerDeps): IpcApi['sessions'] {
  return {
    list: () => surface(() => deps.index.list()),
    refresh: () => surface(() => deps.index.refresh()),
    getTranscript: (id) => surface(() => deps.index.getTranscript(id)),

    listLive: () =>
      surface(async () => {
        const live: LiveClaudeSession[] = []
        for (const session of deps.lifecycle.listLive()) {
          const parsed = parseSessionId(session.sessionId)
          if (!parsed) continue
          const tab = deps.tabs.getById(parsed.tabId)
          const ws = deps.workspaces.getById(parsed.workspaceId)
          live.push({
            sessionId: session.sessionId,
            tabId: parsed.tabId,
            title: tab?.title ?? 'Claude Code',
            workspace: ws?.name ?? session.cwd,
            cwd: session.cwd
          })
        }
        return live
      }),

    clearSuspended: (tabId) =>
      surface(async () => {
        tx(deps.db, () => deps.tabs.clearSuspended(tabId))
      })
  }
}

export function sessionsWireRoutes(h: IpcApi['sessions']): WireRoutes {
  return {
    [Channel.sessionsList]: h.list,
    [Channel.sessionsRefresh]: h.refresh,
    [Channel.sessionsGetTranscript]: h.getTranscript,
    [Channel.sessionsListLive]: h.listLive,
    [Channel.sessionsClearSuspended]: h.clearSuspended
  }
}
