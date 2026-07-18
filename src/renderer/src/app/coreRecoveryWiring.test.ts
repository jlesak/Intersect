import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CoreStatus } from '@common/ipc'

// The wiring's side effects on the terminal slice are behavioral seams, not stores; mock the
// slice surface so the test asserts the calls without booting xterm.
const terminalMock = vi.hoisted(() => ({
  markAllInterrupted: vi.fn(),
  setCoreSpawnGate: vi.fn(),
  disposeSession: vi.fn(),
  disposeWorkspaceSessions: vi.fn(),
  setTerminalFontSize: vi.fn()
}))
vi.mock('@renderer/features/terminal', () => terminalMock)

// One fake preload bridge feeds every store hydrate the wiring may trigger.
const apiMock = vi.hoisted(() => {
  let statusCb: ((status: CoreStatus) => void) | null = null
  const api = {
    system: {
      onCoreStatus: (cb: (status: CoreStatus) => void) => {
        statusCb = cb
        return () => {}
      }
    },
    workspaces: {
      getState: vi.fn(async () => ({
        workspaces: [{ id: 'w1', layout: 'single', activeTabId: null }],
        selectedWorkspaceId: 'w1'
      }))
    },
    projects: {
      list: vi.fn(async () => []),
      listOverrides: vi.fn(async () => [])
    },
    tabs: {
      listByWorkspace: vi.fn(async () => [])
    },
    usage: {
      get: vi.fn(async () => null)
    }
  }
  return { api, emitStatus: (status: CoreStatus) => statusCb?.(status) }
})
vi.mock('@renderer/shared/ipc/client', () => ({ ipc: () => apiMock.api }))

import { useAttentionStore } from '@renderer/features/attention'
import { useTabsStore } from '@renderer/features/tabs'
import { wireCoreRecovery } from './coreRecoveryWiring'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  useAttentionStore.setState({ status: {} })
  useTabsStore.setState({ workspaceId: null })
  wireCoreRecovery()
})

describe('wireCoreRecovery', () => {
  test('keeps the spawn gate open only while the core is ready', () => {
    apiMock.emitStatus({ state: 'ready' })
    apiMock.emitStatus({ state: 'restarting', message: 'x', attempt: 1 })
    apiMock.emitStatus({ state: 'failed', message: 'x' })
    expect(terminalMock.setCoreSpawnGate.mock.calls.map((c) => c[0])).toEqual([true, false, false])
  })

  test('a crash interrupts every session exactly once and clears stale attention', () => {
    useAttentionStore.getState().mark('w1:a', 'waiting')
    apiMock.emitStatus({ state: 'ready' })

    apiMock.emitStatus({ state: 'restarting', message: 'core died', attempt: 1 })
    apiMock.emitStatus({ state: 'failed', message: 'core died' })

    expect(terminalMock.markAllInterrupted).toHaveBeenCalledTimes(1)
    expect(useAttentionStore.getState().status).toEqual({})
  })

  test('recovery after a crash re-hydrates workspaces, projects, usage, and the open tabs', async () => {
    useTabsStore.setState({ workspaceId: 'w1' })
    apiMock.emitStatus({ state: 'ready' })
    apiMock.emitStatus({ state: 'restarting', message: 'core died', attempt: 1 })

    apiMock.emitStatus({ state: 'ready' })
    await flush()

    expect(apiMock.api.workspaces.getState).toHaveBeenCalled()
    expect(apiMock.api.projects.list).toHaveBeenCalled()
    expect(apiMock.api.usage.get).toHaveBeenCalled()
    expect(apiMock.api.tabs.listByWorkspace).toHaveBeenCalledWith('w1')
  })

  test('the initial boot flow never re-hydrates or interrupts anything', async () => {
    apiMock.emitStatus({ state: 'starting' })
    apiMock.emitStatus({ state: 'ready' })
    await flush()

    expect(terminalMock.markAllInterrupted).not.toHaveBeenCalled()
    expect(apiMock.api.workspaces.getState).not.toHaveBeenCalled()
    expect(apiMock.api.tabs.listByWorkspace).not.toHaveBeenCalled()
  })
})
