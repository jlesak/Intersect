import { beforeEach, describe, expect, test } from 'vitest'
import type { NoteDay, NoteEntry } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { createNoteRepo, type NoteRepo } from '../db/noteRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createNotesHandlers, notesWireRoutes } from './notes.ipc'

const all = { text: '', from: null, to: null, before: null, dayLimit: null }

describe('notes handlers', () => {
  let notes: NoteRepo
  let h: IpcApi['notes']

  beforeEach(() => {
    notes = createNoteRepo(makeTestDb(), makeTestDeps())
    h = createNotesHandlers({ notes })
  })

  test('add writes an entry that list returns under its day', async () => {
    const entry = await h.add('Call Bob about the cache')
    expect(entry.body).toBe('Call Bob about the cache')
    expect(await h.list(all)).toEqual([{ day: entry.day, entries: [entry] }])
  })

  test('list passes the search and the range through', async () => {
    await h.add('cache')
    await h.add('lunch')
    const days = await h.list({ ...all, text: 'cach' })
    expect(days.flatMap((d) => d.entries.map((e) => e.body))).toEqual(['cache'])
  })

  test('update replaces the body and remove deletes the entry', async () => {
    const a = await h.add('a')
    const updated = await h.update(a.id, 'b')
    expect(updated.body).toBe('b')
    await h.remove(a.id)
    expect(await h.list(all)).toEqual([])
  })

  test('a repo validation error crosses as a message-only Error', async () => {
    await expect(h.add('   ')).rejects.toThrow(/must not be empty/i)
    await expect(h.update('nope', 'x')).rejects.toThrow(/not found/i)
    await expect(h.list({ ...all, from: 'soon' })).rejects.toThrow(/invalid day/i)
    await expect(h.list({ ...all, before: 'soon' })).rejects.toThrow(/invalid day/i)
    await expect(h.list({ ...all, dayLimit: 0 })).rejects.toThrow(/invalid day limit/i)
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const throwing = createNotesHandlers({
      notes: {
        ...notes,
        list: () => {
          throw 'boom'
        }
      }
    })
    const failure = throwing.list(all)
    await expect(failure).rejects.toBeInstanceOf(Error)
    await expect(failure).rejects.toThrow(/boom/)
  })
})

describe('notesWireRoutes', () => {
  test('binds the request/response channels to the handlers', async () => {
    const h = createNotesHandlers({ notes: createNoteRepo(makeTestDb(), makeTestDeps()) })
    const routes = notesWireRoutes(h)
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)

    expect(Object.keys(routes).sort()).toEqual(
      [Channel.notesList, Channel.notesAdd, Channel.notesUpdate, Channel.notesRemove].sort()
    )

    const added = (await call(Channel.notesAdd, 'first')) as NoteEntry
    await call(Channel.notesUpdate, added.id, 'edited')
    const days = (await call(Channel.notesList, all)) as NoteDay[]
    expect(days.flatMap((d) => d.entries.map((e) => e.body))).toEqual(['edited'])
    await call(Channel.notesRemove, added.id)
    expect(await call(Channel.notesList, all)).toEqual([])
  })
})
