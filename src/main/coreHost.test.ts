import { describe, expect, test, vi } from 'vitest'
import type { CoreStatus } from '@common/ipc'
import {
  CORE_FAILED_PUSH,
  CORE_READY_PUSH,
  CORE_SHUTDOWN_CHANNEL,
  type CoreInitMessage
} from '@common/coreBridge'
import { PortRpc, type RpcPort } from '@common/portRpc'
import { createCoreHost, type CoreHost, type SpawnedCore } from './coreHost'

const INIT: CoreInitMessage = { kind: 'init', userDataDir: '/tmp/x', execPath: '/tmp/electron' }

function makePortPair(): { portA: RpcPort; portB: RpcPort } {
  const aHandlers: ((msg: { data: unknown }) => void)[] = []
  const bHandlers: ((msg: { data: unknown }) => void)[] = []
  return {
    portA: {
      postMessage: (data) => {
        for (const h of bHandlers) h({ data })
      },
      on: (_e, h) => {
        aHandlers.push(h)
      }
    },
    portB: {
      postMessage: (data) => {
        for (const h of aHandlers) h({ data })
      },
      on: (_e, h) => {
        bHandlers.push(h)
      }
    }
  }
}

/** A fake forked core: the host talks to portA, the "core" answers on portB. */
function makeHarness(opts: { readyTimeoutMs?: number } = {}): {
  host: CoreHost
  core: PortRpc
  statuses: CoreStatus[]
  killed: () => boolean
  spawnCount: () => number
  emitExit: (code: number | null) => void
  receivedInit: () => CoreInitMessage | null
} {
  const { portA, portB } = makePortPair()
  const statuses: CoreStatus[] = []
  let killed = false
  let spawns = 0
  let exitCb: ((code: number | null) => void) | null = null
  let receivedInit: CoreInitMessage | null = null

  const spawned: SpawnedCore = {
    port: portA,
    kill: () => {
      killed = true
    },
    onExit: (cb) => {
      exitCb = cb
    }
  }
  const host = createCoreHost({
    spawnCore: (init) => {
      spawns += 1
      receivedInit = init
      return spawned
    },
    init: INIT,
    onStatus: (s) => statuses.push(s),
    readyTimeoutMs: opts.readyTimeoutMs
  })
  const core = new PortRpc(portB)
  return {
    host,
    core,
    statuses,
    killed: () => killed,
    spawnCount: () => spawns,
    emitExit: (code) => exitCb?.(code),
    receivedInit: () => receivedInit
  }
}

describe('createCoreHost lifecycle', () => {
  test('forks exactly one core process and hands it the init message', () => {
    const h = makeHarness()
    h.host.start()
    h.host.start()
    h.host.start()
    expect(h.spawnCount()).toBe(1)
    expect(h.receivedInit()).toEqual(INIT)
    expect(h.host.status()).toEqual({ state: 'starting' })
  })

  test('becomes ready on the ready push and serves requests', async () => {
    const h = makeHarness()
    h.host.start()
    h.core.onRequest(async (channel, args) => ({ channel, args }))

    const pending = h.host.request('todo:list', [])
    h.core.push(CORE_READY_PUSH, null)
    await expect(pending).resolves.toEqual({ channel: 'todo:list', args: [] })
    expect(h.host.status()).toEqual({ state: 'ready' })
    expect(h.statuses.map((s) => s.state)).toEqual(['starting', 'ready'])
  })

  test('a failed bootstrap push produces a terminal failed status and rejects waiting requests', async () => {
    const h = makeHarness()
    h.host.start()
    const pending = h.host.request('todo:list', [])
    h.core.push(CORE_FAILED_PUSH, { message: 'db is corrupt' })

    await expect(pending).rejects.toThrow('core bootstrap failed: db is corrupt')
    expect(h.host.status()).toEqual({
      state: 'failed',
      message: 'core bootstrap failed: db is corrupt'
    })
    expect(h.killed()).toBe(true)
    await expect(h.host.request('todo:list', [])).rejects.toThrow('core bootstrap failed')
  })

  test('unexpected process exit rejects in-flight requests and fails the host', async () => {
    const h = makeHarness()
    h.host.start()
    h.core.push(CORE_READY_PUSH, null)
    h.core.onRequest(() => new Promise(() => {})) // never answers

    const hanging = h.host.request('todo:list', [])
    await Promise.resolve() // let the request cross the port
    h.emitExit(9)
    await expect(hanging).rejects.toThrow('core process exited unexpectedly (code 9)')
    expect(h.host.status().state).toBe('failed')
  })

  test('declares failure when the core never reports ready', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ readyTimeoutMs: 500 })
      h.host.start()
      const pending = h.host.request('todo:list', [])
      vi.advanceTimersByTime(501)
      await expect(pending).rejects.toThrow('did not become ready within 500ms')
      expect(h.killed()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createCoreHost traffic', () => {
  test('forwards pushes to subscribers but keeps lifecycle pushes internal', () => {
    const h = makeHarness()
    h.host.start()
    const seen: Array<[string, unknown]> = []
    h.host.onPush((channel, payload) => seen.push([channel, payload]))

    h.core.push(CORE_READY_PUSH, null)
    h.core.push('terminal:data', { sessionId: 's', data: 'x' })
    expect(seen).toEqual([['terminal:data', { sessionId: 's', data: 'x' }]])
  })

  test('notifications reach the core without a response', async () => {
    const h = makeHarness()
    h.host.start()
    const seen: string[] = []
    h.core.onRequest(async (channel) => {
      seen.push(channel)
    })
    h.core.push(CORE_READY_PUSH, null)

    h.host.notify('terminal:input', ['s1', 'ls\r'])
    await vi.waitFor(() => expect(seen).toEqual(['terminal:input']))
  })

  test('shutdown asks the core to stop, then kills it', async () => {
    const h = makeHarness()
    h.host.start()
    h.core.push(CORE_READY_PUSH, null)
    let askedToShutDown = false
    h.core.onRequest(async (channel) => {
      if (channel === CORE_SHUTDOWN_CHANNEL) askedToShutDown = true
    })

    await h.host.shutdown()
    expect(askedToShutDown).toBe(true)
    expect(h.killed()).toBe(true)
  })

  test('shutdown does not hang when the core never answers', async () => {
    const h = makeHarness()
    h.host.start()
    h.core.push(CORE_READY_PUSH, null)
    h.core.onRequest(() => new Promise(() => {}))

    await h.host.shutdown(20)
    expect(h.killed()).toBe(true)
  })

  test('a shutdown-initiated exit does not flip the host to failed', async () => {
    const h = makeHarness()
    h.host.start()
    h.core.push(CORE_READY_PUSH, null)
    h.core.onRequest(async () => {})

    await h.host.shutdown(20)
    h.emitExit(0)
    expect(h.host.status()).toEqual({ state: 'ready' })
  })
})
