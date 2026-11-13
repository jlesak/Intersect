import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRecordingReminders } from './recording'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intersect-reminders-'))
  file = join(dir, 'todo-reminders.e2e.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const request = (id: string, title = id) => ({
  id, title, body: 'Due 14:30 · Inbox', local: { year: 2026, month: 11, day: 14, hour: 14, minute: 30 }
})
const recorded = (): { id: string; title: string }[] => JSON.parse(readFileSync(file, 'utf8'))

describe('createRecordingReminders', () => {
  test('starts with an empty file and records every pending request', async () => {
    const native = createRecordingReminders(file)
    expect(recorded()).toEqual([])
    await native.schedule([request('todo-reminder:b'), request('todo-reminder:a')])
    expect(recorded().map((r) => r.id)).toEqual(['todo-reminder:a', 'todo-reminder:b'])
  })

  test('replaces a request with the same id and removes cancelled ones', async () => {
    const native = createRecordingReminders(file)
    await native.schedule([request('todo-reminder:a', 'old')])
    await native.schedule([request('todo-reminder:a', 'new')])
    expect(recorded()).toEqual([expect.objectContaining({ id: 'todo-reminder:a', title: 'new' })])
    native.cancel(['todo-reminder:a'])
    expect(recorded()).toEqual([])
  })

  test('keeps the pending requests across a restart of the same profile, as macOS does', async () => {
    await createRecordingReminders(file).schedule([request('todo-reminder:a')])
    const restarted = createRecordingReminders(file)
    expect((await restarted.pending()).map((r) => r.id)).toEqual(['todo-reminder:a'])
    expect(await restarted.authorizationStatus()).toBe('authorized')
  })
})
