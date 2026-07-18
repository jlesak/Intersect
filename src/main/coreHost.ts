import type { CoreStatus } from '@common/ipc'
import {
  CORE_FAILED_PUSH,
  CORE_READY_PUSH,
  CORE_SHUTDOWN_CHANNEL,
  type CoreFailedPayload,
  type CoreInitMessage
} from '@common/coreBridge'
import { PortRpc, type RpcPort } from '@common/portRpc'

/** The forked core process, reduced to what the host needs (utilityProcess in production). */
export interface SpawnedCore {
  port: RpcPort
  kill(): void
  onExit(cb: (code: number | null) => void): void
}

export interface CoreHostDeps {
  /** Fork the core process and hand it the init message plus one end of the port pair. */
  spawnCore(init: CoreInitMessage): SpawnedCore
  init: CoreInitMessage
  /** Observes every lifecycle transition (starting -> ready | failed). */
  onStatus(status: CoreStatus): void
  /** How long bootstrap may take before the host declares the core failed. */
  readyTimeoutMs?: number
}

export interface CoreHost {
  /** Fork exactly once; later calls are no-ops. */
  start(): void
  status(): CoreStatus
  /** Correlated request; waits for readiness, rejects promptly on failure or core death. */
  request(channel: string, args: unknown[]): Promise<unknown>
  /** Fire-and-forget notification (the PTY fast path); silently dropped once the core is gone. */
  notify(channel: string, args: unknown[]): void
  /** Subscribe to core pushes (renderer broadcasts + native commands); returns unsubscribe. */
  onPush(handler: (channel: string, payload: unknown) => void): () => void
  /** Coordinated teardown: ask the core to shut down, then reap the process. */
  shutdown(timeoutMs?: number): Promise<void>
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000

export function createCoreHost(deps: CoreHostDeps): CoreHost {
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  let current: CoreStatus = { state: 'starting' }
  let spawned: SpawnedCore | null = null
  let rpc: PortRpc | null = null
  let shuttingDown = false
  let readyTimer: NodeJS.Timeout | null = null
  const pushHandlers: Array<(channel: string, payload: unknown) => void> = []

  // Requests arriving while the core is still bootstrapping wait here; the promise settles
  // on the ready push, the failed push, process exit, or the readiness timeout.
  let readiness: Promise<void> | null = null
  let readinessResolve: (() => void) | null = null
  let readinessReject: ((err: Error) => void) | null = null

  const setStatus = (status: CoreStatus): void => {
    current = status
    deps.onStatus(status)
  }

  const clearReadyTimer = (): void => {
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
  }

  const fail = (message: string): void => {
    if (current.state === 'failed') return
    clearReadyTimer()
    const err = new Error(message)
    setStatus({ state: 'failed', message })
    readinessReject?.(err)
    rpc?.dispose(err)
  }

  const start = (): void => {
    if (spawned) return
    setStatus({ state: 'starting' })
    readiness = new Promise<void>((resolve, reject) => {
      readinessResolve = resolve
      readinessReject = reject
    })
    // A failed core surfaces through status + rejected requests; nothing awaits readiness
    // without handling rejection, so keep the raw promise from crashing the process.
    readiness.catch(() => {})

    spawned = deps.spawnCore(deps.init)
    rpc = new PortRpc(spawned.port)
    rpc.onPush((channel, payload) => {
      if (channel === CORE_READY_PUSH) {
        clearReadyTimer()
        if (current.state === 'starting') {
          setStatus({ state: 'ready' })
          readinessResolve?.()
        }
        return
      }
      if (channel === CORE_FAILED_PUSH) {
        const message = (payload as CoreFailedPayload | null)?.message ?? 'unknown core failure'
        fail(`core bootstrap failed: ${message}`)
        spawned?.kill()
        return
      }
      for (const handler of [...pushHandlers]) {
        try {
          handler(channel, payload)
        } catch (err) {
          console.error('[coreHost] push handler threw:', err)
        }
      }
    })
    spawned.onExit((code) => {
      if (shuttingDown) return
      fail(`core process exited unexpectedly (code ${code ?? 'unknown'})`)
    })
    readyTimer = setTimeout(() => {
      fail(`core did not become ready within ${readyTimeoutMs}ms`)
      spawned?.kill()
    }, readyTimeoutMs)
  }

  return {
    start,
    status: () => current,

    async request(channel, args) {
      if (!rpc || !readiness) throw new Error('core host not started')
      if (current.state === 'failed') {
        throw new Error(current.message ?? 'core is not available')
      }
      if (current.state === 'starting') await readiness
      return rpc.invoke(channel, args)
    },

    notify(channel, args) {
      // Port messages queue until the core attaches, so notifications sent while the core
      // is still starting are delivered in order once it is up.
      rpc?.notify(channel, args)
    },

    onPush(handler) {
      pushHandlers.push(handler)
      return () => {
        const i = pushHandlers.indexOf(handler)
        if (i >= 0) pushHandlers.splice(i, 1)
      }
    },

    async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
      if (!spawned || !rpc) return
      shuttingDown = true
      clearReadyTimer()
      if (current.state === 'ready') {
        // Give the core a bounded chance to close PTYs/services/DB in order; then reap.
        await Promise.race([
          rpc.invoke(CORE_SHUTDOWN_CHANNEL, []).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ])
      }
      rpc.dispose(new Error('core host shut down'))
      spawned.kill()
    }
  }
}
