import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { NoteRepo } from '../db/noteRepo'

export interface NotesHandlerDeps {
  notes: NoteRepo
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

/** Daily notes handlers: thin delegation to the repo, which owns validation and search. */
export function createNotesHandlers(d: NotesHandlerDeps): IpcApi['notes'] {
  return {
    list: (query) => surface(() => d.notes.list(query)),
    add: (body) => surface(() => d.notes.create(body)),
    update: (id, body) => surface(() => d.notes.update(id, body)),
    remove: (id) => surface(() => d.notes.remove(id))
  }
}

export function notesWireRoutes(h: IpcApi['notes']): WireRoutes {
  return {
    [Channel.notesList]: h.list,
    [Channel.notesAdd]: h.add,
    [Channel.notesUpdate]: h.update,
    [Channel.notesRemove]: h.remove
  }
}
