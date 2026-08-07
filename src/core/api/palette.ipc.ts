import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { AppStateRepo } from '../db/appStateRepo'

/** app_state key the command palette's recently-used list is persisted under. */
const RECENT_KEY = 'palette.recent_command_ids'

/**
 * How many recently-used commands are remembered. Long enough to cover a working day's habits,
 * short enough that the section stays a shortcut rather than becoming a second full listing.
 */
export const RECENT_COMMANDS_LIMIT = 8

export interface PaletteHandlerDeps {
  appState: AppStateRepo
}

/**
 * The stored list, or an empty one for anything that is not a list of strings. A profile written
 * by an older version, or corrupted by hand, must cost the user their command history at worst -
 * never the palette itself.
 */
function read(appState: AppStateRepo): string[] {
  const raw = appState.get(RECENT_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.every((entry) => typeof entry === 'string') ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/**
 * The command palette's own persisted state. Recency is maintained here rather than in the
 * renderer because the store is the thing that has to stay well-formed: a window that crashes
 * mid-update cannot leave a duplicated or unbounded list behind.
 */
export function createPaletteHandlers(d: PaletteHandlerDeps): IpcApi['palette'] {
  return {
    getRecent: async () => read(d.appState),

    recordUse: async (commandId) => {
      const id = commandId.trim()
      if (id === '') return read(d.appState)
      const next = [id, ...read(d.appState).filter((known) => known !== id)].slice(
        0,
        RECENT_COMMANDS_LIMIT
      )
      d.appState.set(RECENT_KEY, JSON.stringify(next))
      return next
    }
  }
}

export function paletteWireRoutes(h: IpcApi['palette']): WireRoutes {
  return {
    [Channel.paletteGetRecent]: h.getRecent,
    [Channel.paletteRecordUse]: h.recordUse
  }
}
