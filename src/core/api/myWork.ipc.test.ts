import { describe, expect, test, vi } from 'vitest'
import type { JiraBoardSnapshot, JiraLoginResult } from '@common/domain'
import { Channel } from '@common/ipc'
import type { JiraLogin } from '../myWork/jiraLogin'
import type { JiraSyncEngine } from '../myWork/jiraSyncEngine'
import { createMyWorkHandlers, myWorkWireRoutes } from './myWork.ipc'

const board = (sourceKey: string, fetchedAt: number): JiraBoardSnapshot => ({
  sourceKey,
  issues: [],
  fetchedAt,
  partial: false,
  error: null
})

const cached = board('global', 1)
const refreshed = board('global', 2)
const loggedIn: JiraLoginResult = { ok: true }

function makeEngine(over: Partial<JiraSyncEngine> = {}): JiraSyncEngine {
  return {
    getBoard: vi.fn(async (sourceKey: string) => (sourceKey === 'global' ? cached : board(sourceKey, 1))),
    refresh: vi.fn(async (sourceKey: string) => (sourceKey === 'global' ? refreshed : board(sourceKey, 2))),
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
  test('list serves the global source from the engine', async () => {
    const engine = makeEngine()
    const h = createMyWorkHandlers({ engine, login: makeLogin() })
    expect(await h.list()).toBe(cached)
    expect(engine.getBoard).toHaveBeenCalledWith('global')
  })

  test('refresh forces the global source', async () => {
    const engine = makeEngine()
    const h = createMyWorkHandlers({ engine, login: makeLogin() })
    expect(await h.refresh()).toBe(refreshed)
    expect(engine.refresh).toHaveBeenCalledWith('global')
  })

  test('projectBoard and refreshProject address the project source key', async () => {
    const engine = makeEngine()
    const h = createMyWorkHandlers({ engine, login: makeLogin() })
    expect((await h.projectBoard('p1')).sourceKey).toBe('project:p1')
    expect(engine.getBoard).toHaveBeenCalledWith('project:p1')
    expect((await h.refreshProject('p1')).sourceKey).toBe('project:p1')
    expect(engine.refresh).toHaveBeenCalledWith('project:p1')
  })

  test('login delegates to the interactive login', async () => {
    const login = makeLogin()
    const h = createMyWorkHandlers({ engine: makeEngine(), login })
    expect(await h.login()).toBe(loggedIn)
    expect(login.login).toHaveBeenCalledOnce()
  })

  test('a failed sync travels inside the envelope, not as a thrown error', async () => {
    const failed: JiraBoardSnapshot = {
      sourceKey: 'global',
      issues: [],
      fetchedAt: null,
      partial: false,
      error: { kind: 'auth', message: 'expired' }
    }
    const h = createMyWorkHandlers({
      engine: makeEngine({ getBoard: vi.fn(async () => failed) }),
      login: makeLogin()
    })
    expect(await h.list()).toBe(failed)
  })

  test('the handler surface exposes no Jira mutation or worklog operation', () => {
    const h = createMyWorkHandlers({ engine: makeEngine(), login: makeLogin() })
    expect(Object.keys(h).sort()).toEqual(
      ['list', 'login', 'projectBoard', 'refresh', 'refreshProject'].sort()
    )
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const engine = makeEngine({
      getBoard: vi.fn(async () => {
        throw 'boom'
      })
    })
    const h = createMyWorkHandlers({ engine, login: makeLogin() })
    await expect(h.list()).rejects.toThrow(/boom/)
  })
})

describe('myWorkWireRoutes', () => {
  test('binds all request/response channels to the handlers', async () => {
    const h = createMyWorkHandlers({ engine: makeEngine(), login: makeLogin() })
    const routes = myWorkWireRoutes(h)

    expect(Object.keys(routes).sort()).toEqual(
      [
        Channel.myWorkList,
        Channel.myWorkRefresh,
        Channel.myWorkLogin,
        Channel.myWorkProjectBoard,
        Channel.myWorkRefreshProject
      ].sort()
    )
    expect(await (routes[Channel.myWorkList] as () => unknown)()).toBe(cached)
    expect(await (routes[Channel.myWorkRefresh] as () => unknown)()).toBe(refreshed)
    expect(await (routes[Channel.myWorkLogin] as () => unknown)()).toBe(loggedIn)
    const projectBoard = routes[Channel.myWorkProjectBoard] as (id: string) => Promise<JiraBoardSnapshot>
    expect((await projectBoard('p1')).sourceKey).toBe('project:p1')
  })
})
