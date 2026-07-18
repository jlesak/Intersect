import { PortRpc, type RpcPort } from '@common/portRpc'
import {
  CORE_FAILED_PUSH,
  CORE_READY_PUSH,
  CORE_SHUTDOWN_CHANNEL,
  type CoreFailedPayload,
  type CoreInitMessage
} from '@common/coreBridge'
import { createCoreRuntime, type CoreRuntime } from './bootstrap'
import { ensureSpawnHelperExecutable, nodePtySpawn } from './pty/nodePtySpawn'
import { applyLoginShellPath } from './loginShellPath'

/**
 * The headless core process entry. Runs as an Electron utilityProcess (plain Node plus
 * `process.parentPort`): main forks it, then posts a single init message carrying the boot
 * inputs and one end of a MessageChannelMain. Everything after that handshake flows through
 * the PortRpc seam - requests in, pushes out.
 */

/** The utilityProcess side of the channel; Electron types are unavailable in this build. */
interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: RpcPort[] }) => void): void
  start?(): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

let runtime: CoreRuntime | null = null

parentPort.on('message', (event) => {
  const message = event.data as Partial<CoreInitMessage>
  if (message?.kind !== 'init' || runtime !== null) return
  const port = event.ports[0]
  if (!port) return

  const rpc = new PortRpc(port)

  // Serve requests immediately so nothing is dropped while bootstrap runs; the first
  // requests simply await the runtime. Bootstrap is synchronous, so in practice only the
  // shutdown race matters.
  rpc.onRequest(async (channel, args) => {
    if (channel === CORE_SHUTDOWN_CHANNEL) {
      shutdownAndExit()
      return
    }
    if (!runtime) throw new Error('core is not ready')
    return runtime.handleRequest(channel, args)
  })

  const shutdownAndExit = (): void => {
    try {
      runtime?.shutdown()
    } finally {
      // Let the shutdown response flush before the process disappears.
      setTimeout(() => process.exit(0), 0)
    }
  }

  try {
    runtime = createCoreRuntime({
      userDataDir: message.userDataDir!,
      execPath: message.execPath!,
      env: process.env,
      emitPush: (channel, payload) => rpc.push(channel, payload),
      spawn: nodePtySpawn,
      ensureSpawnHelper: ensureSpawnHelperExecutable,
      applyLoginShellPath
    })
    rpc.push(CORE_READY_PUSH, null)
  } catch (err) {
    // Stay alive so the failure push reaches main; main owns the decision to kill us.
    const payload: CoreFailedPayload = {
      message: err instanceof Error ? err.message : String(err)
    }
    rpc.push(CORE_FAILED_PUSH, payload)
  }
})
parentPort.start?.()
