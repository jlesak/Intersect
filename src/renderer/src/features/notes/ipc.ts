import type { NoteDay, NoteEntry, NoteQuery } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the notes store and the preload bridge.
export const list = (query: NoteQuery): Promise<NoteDay[]> => ipc().notes.list(query)
export const add = (body: string): Promise<NoteEntry> => ipc().notes.add(body)
export const update = (id: string, body: string): Promise<NoteEntry> =>
  ipc().notes.update(id, body)
export const remove = (id: string): Promise<void> => ipc().notes.remove(id)
