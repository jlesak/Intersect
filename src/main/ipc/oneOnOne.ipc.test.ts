import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import type { OtoRun } from '@common/domain'
import { Channel } from '@common/ipc'
import { createOtoRunRepo, type OtoRunRepo } from '../db/otoRunRepo'
import { createTodoRepo, type TodoRepo } from '../db/todoRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { OtoStartRequest } from '../oneOnOne/otoManager'
import { createOneOnOneHandlers, registerOneOnOneHandlers, type OneOnOneHandlers } from './oneOnOne.ipc'

interface FakeManager {
  start: Mock<(req: OtoStartRequest) => OtoRun>
  requests: OtoStartRequest[]
}

function makeFakeManager(runs: OtoRunRepo): FakeManager {
  const requests: OtoStartRequest[] = []
  const start = vi.fn((req: OtoStartRequest): OtoRun => {
    requests.push(req)
    return runs.create({ type: req.type, person: req.person, vttPath: req.vttPath ?? null })
  })
  return { start, requests }
}

describe('oneOnOne handlers', () => {
  let runs: OtoRunRepo
  let todos: TodoRepo
  let manager: FakeManager
  let h: OneOnOneHandlers

  beforeEach(() => {
    const db = makeTestDb()
    const deps = makeTestDeps()
    runs = createOtoRunRepo(db, deps)
    todos = createTodoRepo(db, deps)
    manager = makeFakeManager(runs)
    h = createOneOnOneHandlers({
      runs,
      manager,
      todos,
      pickVttFile: async () => '/picked/recording.vtt',
      fileExists: (path) => path === '/ok/marek.vtt'
    })
  })

  test('list returns the run history newest first', async () => {
    const a = runs.create({ type: 'process', person: 'A', vttPath: '/a.vtt' })
    const b = runs.create({ type: 'prep', person: 'B', vttPath: null })
    expect((await h.list()).map((r) => r.id)).toEqual([b.id, a.id])
  })

  test('start(process) validates and hands the manager the trimmed person and vtt path', async () => {
    const run = await h.start({ type: 'process', person: '  Marek K. ', vttPath: '/ok/marek.vtt' })
    expect(run.status).toBe('running')
    expect(manager.requests).toEqual([
      { type: 'process', person: 'Marek K.', vttPath: '/ok/marek.vtt', todoMentions: [] }
    ])
  })

  test('start(prep) splices matching TODO items (open and done) into the request', async () => {
    todos.create('Ask Marek about the rate limit fix', null)
    const doneTask = todos.create('Review the PR from marek', null)
    todos.setDone(doneTask.id, true)
    todos.create('Order a monitor', null)

    await h.start({ type: 'prep', person: 'Marek K.' })
    expect(manager.requests).toEqual([
      {
        type: 'prep',
        person: 'Marek K.',
        vttPath: null,
        todoMentions: [
          '- [open] Ask Marek about the rate limit fix',
          '- [done] Review the PR from marek'
        ]
      }
    ])
  })

  test('start rejects an empty person and an unknown type without touching the manager', async () => {
    await expect(h.start({ type: 'prep', person: '   ' })).rejects.toThrow(/must not be empty/)
    await expect(
      h.start({ type: 'evil' as 'prep', person: 'Marek' })
    ).rejects.toThrow(/Unknown workflow type/)
    expect(manager.start).not.toHaveBeenCalled()
  })

  test('start(process) rejects a missing, non-vtt, or nonexistent recording', async () => {
    await expect(h.start({ type: 'process', person: 'Marek' })).rejects.toThrow(/Choose a VTT/)
    await expect(
      h.start({ type: 'process', person: 'Marek', vttPath: '/ok/notes.txt' })
    ).rejects.toThrow(/must be a \.vtt file/)
    await expect(
      h.start({ type: 'process', person: 'Marek', vttPath: '/gone/marek.vtt' })
    ).rejects.toThrow(/does not exist/)
    expect(manager.start).not.toHaveBeenCalled()
  })

  test('start(prep) ignores a vtt path the renderer may have left in the form', async () => {
    await h.start({ type: 'prep', person: 'Marek', vttPath: '/ok/marek.vtt' })
    expect(manager.requests[0].vttPath).toBeNull()
  })

  test('pickVttFile passes the dialog result through', async () => {
    expect(await h.pickVttFile()).toBe('/picked/recording.vtt')
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const throwing = createOneOnOneHandlers({
      runs: {
        ...runs,
        listAll: () => {
          throw 'boom'
        }
      },
      manager,
      todos,
      pickVttFile: async () => null
    })
    await expect(throwing.list()).rejects.toThrow(/boom/)
  })
})

describe('registerOneOnOneHandlers', () => {
  test('binds the three request/response channels to the handlers', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const db = makeTestDb()
    const deps = makeTestDeps()
    const runs = createOtoRunRepo(db, deps)
    const h = createOneOnOneHandlers({
      runs,
      manager: makeFakeManager(runs),
      todos: createTodoRepo(db, deps),
      pickVttFile: async () => null,
      fileExists: () => true
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerOneOnOneHandlers(ipcMain as any, h)

    expect([...registered.keys()].sort()).toEqual(
      [Channel.oneOnOneList, Channel.oneOnOneStart, Channel.oneOnOnePickVtt].sort()
    )

    const started = (await registered.get(Channel.oneOnOneStart)!(
      {},
      { type: 'prep', person: 'Marek' }
    )) as OtoRun
    expect(started.person).toBe('Marek')
    const listed = (await registered.get(Channel.oneOnOneList)!({})) as OtoRun[]
    expect(listed.map((r) => r.id)).toEqual([started.id])
  })
})
