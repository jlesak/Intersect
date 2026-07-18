import { describe, expect, test, vi } from 'vitest'
import type { SessionSummary, SessionTranscript } from '@common/domain'
import { Channel } from '@common/ipc'
import type { SessionIndex } from '../sessions/sessionIndex'
import { createSessionHandlers, sessionsWireRoutes } from './sessions.ipc'

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

describe('sessionsWireRoutes', () => {
  test('binds the three request/response channels to the handlers', async () => {
    const h = createSessionHandlers({ index: makeIndex() })
    const routes = sessionsWireRoutes(h)
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)

    expect(Object.keys(routes).sort()).toEqual(
      [Channel.sessionsList, Channel.sessionsRefresh, Channel.sessionsGetTranscript].sort()
    )

    const listResult = (await call(Channel.sessionsList)) as SessionSummary[]
    expect(listResult.map((s) => s.id)).toEqual(['s1'])

    const t = await call(Channel.sessionsGetTranscript, 's1')
    expect(t).toBe(transcript)
  })
})
