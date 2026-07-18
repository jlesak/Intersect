import { afterEach, describe, expect, test, vi } from 'vitest'
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

// The delay the host waits before respawning a crashed core (keeps a fast-failing init from
// tight-looping); tests advance fake timers past it to reach the next fork.
const RESPAWN_DELAY_MS = 500

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

interface Fork {
  core: PortRpc
  killed: boolean
  exitCb: ((code: number | null) => void) | null
  receivedInit: CoreInitMessage
}

/**
 * A fake forked core per spawn: the host talks to portA, the "core" answers on portB. Every
 * fork mints a fresh port pair + core-side rpc, so restart tests can drive each attempt's
 * core independently. `core`/`killed`/`emitExit` address the latest fork.
 */
function makeHarness(opts: { readyTimeoutMs?: number } = {}): {
  host: CoreHost
  statuses: CoreStatus[]
  forks: Fork[]
  core: () => PortRpc
  killed: () => boolean
  spawnCount: () => number
  emitExit: (code: number | null) => void
  receivedInit: () => CoreInitMessage | null
} {
  const statuses: CoreStatus[] = []
  const forks: Fork[] = []

  const host = createCoreHost({
    spawnCore: (init) => {
      const { portA, portB } = makePortPair()
      const fork: Fork = { core: new PortRpc(portB), killed: false, exitCb: null, receivedInit: init }
      forks.push(fork)
      const spawned: SpawnedCore = {
        port: portA,
        kill: () => {
          fork.killed = true
        },
        onExit: (cb) => {
          fork.exitCb = cb
        }
      }
      return spawned
    },
    init: INIT,
    onStatus: (s) => statuses.push(s),
    readyTimeoutMs: opts.readyTimeoutMs
  })

  const latest = (): Fork => {
    const fork = forks[forks.length - 1]
    if (!fork) throw new Error('no core forked yet')
    return fork
  }
  return {
    host,
    statuses,
    forks,
    core: () => latest().core,
    killed: () => latest().killed,
    spawnCount: () => forks.length,
    emitExit: (code) => latest().exitCb?.(code),
    receivedInit: () => forks[forks.length - 1]?.receivedInit ?? null
  }
}

afterEach(() => {
  vi.useRealTimers()
})

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
    h.core().onRequest(async (channel, args) => ({ channel, args }))

    const pending = h.host.request('todo:list', [])
    h.core().push(CORE_READY_PUSH, null)
    await expect(pending).resolves.toEqual({ channel: 'todo:list', args: [] })
    expect(h.host.status()).toEqual({ state: 'ready' })
    expect(h.statuses.map((s) => s.state)).toEqual(['starting', 'ready'])
  })

  test('a failed bootstrap push rejects waiting requests and schedules an automatic restart', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    const pending = h.host.request('todo:list', [])
    h.core().push(CORE_FAILED_PUSH, { message: 'db is corrupt' })

    await expect(pending).rejects.toThrow('core bootstrap failed: db is corrupt')
    expect(h.killed()).toBe(true)
    expect(h.host.status()).toEqual({
      state: 'restarting',
      message: 'core bootstrap failed: db is corrupt',
      attempt: 1
    })

    vi.advanceTimersByTime(RESPAWN_DELAY_MS)
    expect(h.spawnCount()).toBe(2)
    h.core().onRequest(async (channel) => `recovered:${channel}`)
    h.core().push(CORE_READY_PUSH, null)
    expect(h.host.status()).toEqual({ state: 'ready' })
    await expect(h.host.request('todo:list', [])).resolves.toBe('recovered:todo:list')
  })

  test('unexpected process exit rejects in-flight requests and enters restarting', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.core().onRequest(() => new Promise(() => {})) // never answers

    const hanging = h.host.request('todo:list', [])
    await Promise.resolve() // let the request cross the port
    h.emitExit(9)
    await expect(hanging).rejects.toThrow('core process exited unexpectedly (code 9)')
    expect(h.host.status()).toEqual({
      state: 'restarting',
      message: 'core process exited unexpectedly (code 9)',
      attempt: 1
    })
  })

  test('a core that never reports ready is killed and restarted', async () => {
    vi.useFakeTimers()
    const h = makeHarness({ readyTimeoutMs: 500 })
    h.host.start()
    const pending = h.host.request('todo:list', [])
    vi.advanceTimersByTime(501)
    await expect(pending).rejects.toThrow('did not become ready within 500ms')
    expect(h.forks[0].killed).toBe(true)
    expect(h.host.status().state).toBe('restarting')
  })
})

describe('createCoreHost restart gate', () => {
  /** Bring the latest fork to ready, then crash it, returning the status after the crash. */
  function readyThenCrash(h: ReturnType<typeof makeHarness>): CoreStatus {
    h.core().push(CORE_READY_PUSH, null)
    h.emitExit(1)
    return h.host.status()
  }

  test('restarts at most three times within a rolling minute, then fails', () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()

    for (let attempt = 1; attempt <= 3; attempt++) {
      const status = readyThenCrash(h)
      expect(status).toMatchObject({ state: 'restarting', attempt })
      vi.advanceTimersByTime(RESPAWN_DELAY_MS)
      expect(h.spawnCount()).toBe(attempt + 1)
    }

    expect(readyThenCrash(h).state).toBe('failed')
    vi.advanceTimersByTime(RESPAWN_DELAY_MS)
    expect(h.spawnCount()).toBe(4)
  })

  test('the rolling window forgets restarts older than a minute', () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()

    for (let attempt = 1; attempt <= 3; attempt++) {
      readyThenCrash(h)
      vi.advanceTimersByTime(RESPAWN_DELAY_MS)
    }
    // All three restarts age out of the 60 s window before the next crash.
    h.core().push(CORE_READY_PUSH, null)
    vi.advanceTimersByTime(61_000)
    h.emitExit(1)
    expect(h.host.status()).toMatchObject({ state: 'restarting', attempt: 1 })
  })

  test('a request during the restarting window is served by the recovered core', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.emitExit(1)

    const pending = h.host.request('todo:list', [])
    vi.advanceTimersByTime(RESPAWN_DELAY_MS)
    h.core().onRequest(async (channel) => `recovered:${channel}`)
    h.core().push(CORE_READY_PUSH, null)
    await expect(pending).resolves.toBe('recovered:todo:list')
  })

  test('requests reject immediately once the gate is exhausted, and retry starts fresh', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    for (let i = 0; i < 4; i++) {
      h.core().push(CORE_READY_PUSH, null)
      h.emitExit(1)
      vi.advanceTimersByTime(RESPAWN_DELAY_MS)
    }
    expect(h.host.status().state).toBe('failed')
    expect(h.spawnCount()).toBe(4)
    await expect(h.host.request('todo:list', [])).rejects.toThrow('exited unexpectedly')

    h.host.retry()
    expect(h.host.status()).toEqual({ state: 'starting' })
    expect(h.spawnCount()).toBe(5)
    h.core().onRequest(async () => 'alive')
    h.core().push(CORE_READY_PUSH, null)
    await expect(h.host.request('todo:list', [])).resolves.toBe('alive')
    // The retry reset the rolling window: the next crash restarts instead of failing.
    h.emitExit(1)
    expect(h.host.status()).toMatchObject({ state: 'restarting', attempt: 1 })
  })

  test('retry outside the failed state is a no-op', () => {
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.host.retry()
    expect(h.spawnCount()).toBe(1)
    expect(h.host.status()).toEqual({ state: 'ready' })
  })

  test('notifications during the dead window are dropped silently', () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.emitExit(1)

    expect(() => h.host.notify('terminal:input', ['s1', 'x'])).not.toThrow()
  })

  test('push subscribers survive a restart', () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    const seen: Array<[string, unknown]> = []
    h.host.onPush((channel, payload) => seen.push([channel, payload]))
    h.core().push(CORE_READY_PUSH, null)
    h.emitExit(1)
    vi.advanceTimersByTime(RESPAWN_DELAY_MS)

    h.core().push(CORE_READY_PUSH, null)
    h.core().push('terminal:data', { sessionId: 's', data: 'x' })
    expect(seen).toEqual([['terminal:data', { sessionId: 's', data: 'x' }]])
  })

  test('shutdown cancels a pending automatic respawn', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.emitExit(1)
    expect(h.host.status().state).toBe('restarting')

    await h.host.shutdown(20)
    vi.advanceTimersByTime(RESPAWN_DELAY_MS + 60_000)
    expect(h.spawnCount()).toBe(1)
  })
})

describe('createCoreHost traffic', () => {
  test('forwards pushes to subscribers but keeps lifecycle pushes internal', () => {
    const h = makeHarness()
    h.host.start()
    const seen: Array<[string, unknown]> = []
    h.host.onPush((channel, payload) => seen.push([channel, payload]))

    h.core().push(CORE_READY_PUSH, null)
    h.core().push('terminal:data', { sessionId: 's', data: 'x' })
    expect(seen).toEqual([['terminal:data', { sessionId: 's', data: 'x' }]])
  })

  test('notifications reach the core without a response', async () => {
    const h = makeHarness()
    h.host.start()
    const seen: string[] = []
    h.core().onRequest(async (channel) => {
      seen.push(channel)
    })
    h.core().push(CORE_READY_PUSH, null)

    h.host.notify('terminal:input', ['s1', 'ls\r'])
    await vi.waitFor(() => expect(seen).toEqual(['terminal:input']))
  })

  test('shutdown asks the core to stop, then kills it', async () => {
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    let askedToShutDown = false
    h.core().onRequest(async (channel) => {
      if (channel === CORE_SHUTDOWN_CHANNEL) askedToShutDown = true
    })

    await h.host.shutdown()
    expect(askedToShutDown).toBe(true)
    expect(h.killed()).toBe(true)
  })

  test('shutdown does not hang when the core never answers', async () => {
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.core().onRequest(() => new Promise(() => {}))

    await h.host.shutdown(20)
    expect(h.killed()).toBe(true)
  })

  test('a shutdown-initiated exit does not flip the host to failed or restarting', async () => {
    const h = makeHarness()
    h.host.start()
    h.core().push(CORE_READY_PUSH, null)
    h.core().onRequest(async () => {})

    await h.host.shutdown(20)
    h.emitExit(0)
    expect(h.host.status()).toEqual({ state: 'ready' })
  })
})
