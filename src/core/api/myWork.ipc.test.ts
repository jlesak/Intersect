import { describe, expect, test, vi } from 'vitest'
import type { JiraBoardResult, JiraLoginResult } from '@common/domain'
import { Channel } from '@common/ipc'
import type { JiraIndex } from '../myWork/jiraIndex'
import type { JiraLogin } from '../myWork/jiraLogin'
import { createMyWorkHandlers, myWorkWireRoutes } from './myWork.ipc'

const board: JiraBoardResult = { ok: true, issues: [], fetchedAt: 1 }
const refreshed: JiraBoardResult = { ok: true, issues: [], fetchedAt: 2 }
const loggedIn: JiraLoginResult = { ok: true }

function makeIndex(over: Partial<JiraIndex> = {}): JiraIndex {
  return {
    list: vi.fn(async () => board),
    refresh: vi.fn(async () => refreshed),
    ...over
  }
}

function makeLogin(over: Partial<JiraLogin> = {}): JiraLogin {
  return {
    login: vi.fn(async () => loggedIn),
    dispose: vi.fn(),
    ...over
  }
}

describe('myWork handlers', () => {
  test('list delegates to the index', async () => {
    const index = makeIndex()
    const h = createMyWorkHandlers({ index, login: makeLogin() })
    expect(await h.list()).toBe(board)
    expect(index.list).toHaveBeenCalledOnce()
  })

  test('refresh delegates to the index', async () => {
    const index = makeIndex()
    const h = createMyWorkHandlers({ index, login: makeLogin() })
    expect(await h.refresh()).toBe(refreshed)
    expect(index.refresh).toHaveBeenCalledOnce()
  })

  test('login delegates to the interactive login', async () => {
    const login = makeLogin()
    const h = createMyWorkHandlers({ index: makeIndex(), login })
    expect(await h.login()).toBe(loggedIn)
    expect(login.login).toHaveBeenCalledOnce()
  })

  test('a failed fetch travels as data, not as a thrown error', async () => {
    const failure: JiraBoardResult = { ok: false, kind: 'auth', message: 'expired' }
    const h = createMyWorkHandlers({
      index: makeIndex({ list: vi.fn(async () => failure) }),
      login: makeLogin()
    })
    expect(await h.list()).toBe(failure)
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const index = makeIndex({
      list: vi.fn(async () => {
        throw 'boom'
      })
    })
    const h = createMyWorkHandlers({ index, login: makeLogin() })
    await expect(h.list()).rejects.toThrow(/boom/)
  })
})

describe('myWorkWireRoutes', () => {
  test('binds all request/response channels to the handlers', async () => {
    const h = createMyWorkHandlers({ index: makeIndex(), login: makeLogin() })
    const routes = myWorkWireRoutes(h)
    const call = (channel: string): unknown => (routes[channel] as () => unknown)()

    expect(Object.keys(routes).sort()).toEqual(
      [Channel.myWorkList, Channel.myWorkRefresh, Channel.myWorkLogin].sort()
    )
    expect(await call(Channel.myWorkList)).toBe(board)
    expect(await call(Channel.myWorkRefresh)).toBe(refreshed)
    expect(await call(Channel.myWorkLogin)).toBe(loggedIn)
  })
})
