import { describe, expect, test, vi } from 'vitest'
import type { SessionSummary, SessionTranscript } from '@common/domain'
import { Channel } from '@common/ipc'
import type { SessionIndex } from '../sessions/sessionIndex'
import { createSessionHandlers, registerSessionHandlers } from './sessions.ipc'

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  filePath: '/p/a/s1.jsonl',
  cwd: '/repo',
  folderName: 'repo',
  title: 'A session',
  gitBranch: null,
  firstTimestamp: 1,
  lastTimestamp: 2,
  durationMs: 1,
  messageCount: 2,
  userPrompts: ['hi'],
  ...over
})

const transcript: SessionTranscript = { id: 's1', title: 'A session', cwd: '/repo', entries: [] }

function makeIndex(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    list: vi.fn(async () => [summary()]),
    refresh: vi.fn(async () => [summary({ id: 's2' })]),
    getTranscript: vi.fn(async () => transcript),
    ...over
  }
}

describe('session handlers', () => {
  test('list delegates to the index', async () => {
    const index = makeIndex()
    const h = createSessionHandlers({ index })
    expect((await h.list()).map((s) => s.id)).toEqual(['s1'])
    expect(index.list).toHaveBeenCalledOnce()
  })

  test('refresh delegates to the index', async () => {
    const index = makeIndex()
    const h = createSessionHandlers({ index })
    expect((await h.refresh()).map((s) => s.id)).toEqual(['s2'])
    expect(index.refresh).toHaveBeenCalledOnce()
  })

  test('getTranscript delegates with the id', async () => {
    const index = makeIndex()
    const h = createSessionHandlers({ index })
    expect(await h.getTranscript('s1')).toBe(transcript)
    expect(index.getTranscript).toHaveBeenCalledWith('s1')
  })

  test('wraps a thrown error as a message-only Error', async () => {
    const index = makeIndex({
      getTranscript: vi.fn(async () => {
        throw new Error('Unknown session: nope')
      })
    })
    const h = createSessionHandlers({ index })
    await expect(h.getTranscript('nope')).rejects.toThrow(/Unknown session: nope/)
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const index = makeIndex({
      list: vi.fn(async () => {
        throw 'boom'
      })
    })
    const h = createSessionHandlers({ index })
    await expect(h.list()).rejects.toThrow(/boom/)
  })
})

describe('registerSessionHandlers', () => {
  test('binds the three request/response channels to the handlers', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const h = createSessionHandlers({ index: makeIndex() })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSessionHandlers(ipcMain as any, h)

    expect([...registered.keys()].sort()).toEqual(
      [Channel.sessionsList, Channel.sessionsRefresh, Channel.sessionsGetTranscript].sort()
    )

    const listResult = (await registered.get(Channel.sessionsList)!()) as SessionSummary[]
    expect(listResult.map((s) => s.id)).toEqual(['s1'])

    const t = await registered.get(Channel.sessionsGetTranscript)!({}, 's1')
    expect(t).toBe(transcript)
  })
})
