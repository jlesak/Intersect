import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { NativeReminders } from './native'
import type { PendingReminder } from './plan'

/**
 * The e2e stand-in for the addon. It keeps a pending store with the same rules as macOS (a request
 * with an existing id replaces it, cancel removes by id, the store survives a restart) and writes
 * the store to a file in the test profile after every change, so a spec can read what would be
 * waiting in macOS. It never touches the system's notification center.
 */
export function createRecordingReminders(file: string): NativeReminders {
  const pending = new Map<string, PendingReminder>()
  if (existsSync(file)) {
    for (const request of JSON.parse(readFileSync(file, 'utf8')) as PendingReminder[]) {
      pending.set(request.id, request)
    }
  }
  const record = (): void => {
    const sorted = [...pending.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    writeFileSync(file, JSON.stringify(sorted, null, 2))
  }
  record()
  return {
    authorizationStatus: async () => 'authorized',
    requestAuthorization: async () => true,
    async schedule(requests) {
      for (const { id, title, body, local } of requests) {
        pending.set(id, { id, title, body, local: { ...local } })
      }
      record()
    },
    cancel(ids) {
      for (const id of ids) pending.delete(id)
      record()
    },
    pending: async () => [...pending.values()].map((request) => ({ ...request }))
  }
}
