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
  /** Observes every lifecycle transition (starting -> ready | restarting | failed). */
  onStatus(status: CoreStatus): void
  /** How long bootstrap may take before the host declares the attempt crashed. */
  readyTimeoutMs?: number
}

export interface CoreHost {
  /** Begin the first fork exactly once; later calls are no-ops. */
  start(): void
  status(): CoreStatus
  /** Correlated request; waits for readiness, rejects promptly on failure or core death. */
  request(channel: string, args: unknown[]): Promise<unknown>
  /** Fire-and-forget notification (the PTY fast path); silently dropped while the core is gone. */
  notify(channel: string, args: unknown[]): void
  /** Subscribe to core pushes (renderer broadcasts + native commands); survives restarts. */
  onPush(handler: (channel: string, payload: unknown) => void): () => void
  /** Manual recovery from the failed state: reset the crash-loop gate and fork afresh. */
  retry(): void
  /** Coordinated teardown: ask the core to shut down, then reap the process. */
  shutdown(timeoutMs?: number): Promise<void>
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000

// Crash-loop gate: at most this many automatic restarts within the rolling window; beyond
// that the host stays failed until the user retries or quits.
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS_PER_WINDOW = 3
// Breathing room before a respawn so a core that dies during init cannot tight-loop the CPU.
const RESPAWN_DELAY_MS = 500

/** One fork's live wiring; every crash discards it wholesale (a PortRpc cannot be revived). */
interface Attempt {
  spawned: SpawnedCore
  rpc: PortRpc
  readyTimer: NodeJS.Timeout | null
}

export function createCoreHost(deps: CoreHostDeps): CoreHost {
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  let current: CoreStatus = { state: 'starting' }
  let started = false
  let shuttingDown = false
  let attempt: Attempt | null = null
  let respawnTimer: NodeJS.Timeout | null = null
  let restartTimes: number[] = []
  const pushHandlers: Array<(channel: string, payload: unknown) => void> = []

  // Requests arriving while the core is bootstrapping (or respawning after a crash) wait
  // here; the promise settles on the ready push, or rejects when that attempt dies.
  let readiness: Promise<void> | null = null
  let readinessResolve: (() => void) | null = null
  let readinessReject: ((err: Error) => void) | null = null

  const setStatus = (status: CoreStatus): void => {
    current = status
    deps.onStatus(status)
  }

  const newReadiness = (): void => {
    readiness = new Promise<void>((resolve, reject) => {
      readinessResolve = resolve
      readinessReject = reject
    })
    // Failures surface through status + rejected requests; nothing awaits readiness without
    // handling rejection, so keep the raw promise from crashing the process.
    readiness.catch(() => {})
  }

  const clearReadyTimer = (att: Attempt): void => {
    if (att.readyTimer) clearTimeout(att.readyTimer)
    att.readyTimer = null
  }

  /**
   * The current attempt died (process exit, bootstrap-failed push, or ready timeout): reject
   * everything waiting on it, then either schedule an automatic respawn or - once the
   * crash-loop gate is exhausted - settle into the failed state awaiting manual recovery.
   */
  const crash = (message: string, att: Attempt): void => {
    if (att !== attempt || shuttingDown) return
    clearReadyTimer(att)
    attempt = null
    const err = new Error(message)
    readinessReject?.(err)
    att.rpc.dispose(err)

    const now = Date.now()
    restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (restartTimes.length < MAX_RESTARTS_PER_WINDOW) {
      restartTimes.push(now)
      newReadiness()
      setStatus({ state: 'restarting', message, attempt: restartTimes.length })
      respawnTimer = setTimeout(spawnAttempt, RESPAWN_DELAY_MS)
    } else {
      setStatus({ state: 'failed', message })
    }
  }

  const spawnAttempt = (): void => {
    respawnTimer = null
    const spawned = deps.spawnCore(deps.init)
    const rpc = new PortRpc(spawned.port)
    const att: Attempt = { spawned, rpc, readyTimer: null }
    attempt = att

    rpc.onPush((channel, payload) => {
      if (channel === CORE_READY_PUSH) {
        clearReadyTimer(att)
        if (current.state === 'starting' || current.state === 'restarting') {
          setStatus({ state: 'ready' })
          readinessResolve?.()
        }
        return
      }
      if (channel === CORE_FAILED_PUSH) {
        const message = (payload as CoreFailedPayload | null)?.message ?? 'unknown core failure'
        att.spawned.kill()
        crash(`core bootstrap failed: ${message}`, att)
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
      crash(`core process exited unexpectedly (code ${code ?? 'unknown'})`, att)
    })
    att.readyTimer = setTimeout(() => {
      att.spawned.kill()
      crash(`core did not become ready within ${readyTimeoutMs}ms`, att)
    }, readyTimeoutMs)
  }

  return {
    start() {
      if (started) return
      started = true
      setStatus({ state: 'starting' })
      newReadiness()
      spawnAttempt()
    },

    status: () => current,

    async request(channel, args) {
      if (!started) throw new Error('core host not started')
      if (current.state === 'failed') {
        throw new Error(current.message ?? 'core is not available')
      }
      // starting/restarting: wait for the current attempt; its failure rejects this request.
      if (current.state !== 'ready') await readiness
      const rpc = attempt?.rpc
      if (!rpc) throw new Error(current.message ?? 'core is not available')
      return rpc.invoke(channel, args)
    },

    notify(channel, args) {
      // Port messages queue until the core attaches, so notifications sent while the core is
      // starting are delivered in order once it is up. With no live attempt (crashed core)
      // they are dropped: fire-and-forget traffic has no meaning for a process that is gone.
      attempt?.rpc.notify(channel, args)
    },

    onPush(handler) {
      pushHandlers.push(handler)
      return () => {
        const i = pushHandlers.indexOf(handler)
        if (i >= 0) pushHandlers.splice(i, 1)
      }
    },

    retry() {
      if (current.state !== 'failed') return
      restartTimes = []
      newReadiness()
      setStatus({ state: 'starting' })
      spawnAttempt()
    },

    async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
      shuttingDown = true
      if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
      }
      const att = attempt
      if (!att) return
      clearReadyTimer(att)
      if (current.state === 'ready') {
        // Give the core a bounded chance to close PTYs/services/DB in order; then reap.
        await Promise.race([
          att.rpc.invoke(CORE_SHUTDOWN_CHANNEL, []).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ])
      }
      att.rpc.dispose(new Error('core host shut down'))
      att.spawned.kill()
    }
  }
}
