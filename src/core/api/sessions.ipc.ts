import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { SessionIndex } from '../sessions/sessionIndex'

export interface SessionHandlerDeps {
  index: SessionIndex
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
 * Session search handlers: thin delegation to the in-memory {@link SessionIndex}. The index owns
 * the caching and disk I/O; these handlers only bridge it to IPC and normalize errors.
 */
export function createSessionHandlers(deps: SessionHandlerDeps): IpcApi['sessions'] {
  return {
    list: () => surface(() => deps.index.list()),
    refresh: () => surface(() => deps.index.refresh()),
    getTranscript: (id) => surface(() => deps.index.getTranscript(id))
  }
}

export function sessionsWireRoutes(h: IpcApi['sessions']): WireRoutes {
  return {
    [Channel.sessionsList]: h.list,
    [Channel.sessionsRefresh]: h.refresh,
    [Channel.sessionsGetTranscript]: h.getTranscript
  }
}
