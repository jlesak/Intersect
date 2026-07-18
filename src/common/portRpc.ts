/**
 * Correlated RPC and push messaging over a MessagePort-like channel. This is the single
 * transport seam between Electron main and the headless core utility process: requests
 * carry an id and settle exactly once; notifications are fire-and-forget requests with no
 * response (the PTY fast path); pushes flow the other way with no correlation at all.
 *
 * Only an error's `.message` crosses the wire, mirroring how Electron IPC already strips
 * thrown errors, so both hops of the renderer -> main -> core chain lose the same amount.
 */

/** The minimal port surface shared by MessagePortMain (main) and process.parentPort (core). */
export interface RpcPort {
  postMessage(data: unknown): void
  on(event: 'message', handler: (msg: { data: unknown }) => void): void
  start?(): void
}

interface WireRequest {
  /** Absent for notifications: no response is expected or ever sent. */
  id?: string
  channel: string
  args: unknown[]
}

interface WireResponse {
  id: string
  ok: boolean
  value?: unknown
  error?: { message: string }
  /** Discriminates a response from a request that happens to carry an `id`. */
  response: true
}

interface WirePush {
  push: string
  payload: unknown
}

type RequestHandler = (channel: string, args: unknown[]) => Promise<unknown>
type PushHandler = (channel: string, payload: unknown) => void

let nextId = 0

export class PortRpc {
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()
  private requestHandler: RequestHandler | null = null
  private pushHandlers: PushHandler[] = []
  private disposedWith: Error | null = null

  constructor(private port: RpcPort) {
    port.on('message', (msg) => this.handle(msg.data))
    port.start?.()
  }

  /** Send a correlated request; resolves/rejects exactly once with the remote result. */
  invoke(channel: string, args: unknown[]): Promise<unknown> {
    if (this.disposedWith) return Promise.reject(this.disposedWith)
    const id = `${++nextId}:${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ id, channel, args } satisfies WireRequest)
    })
  }

  /** Fire-and-forget request: routed to the remote handler, but never answered. */
  notify(channel: string, args: unknown[]): void {
    if (this.disposedWith) return
    this.post({ channel, args } satisfies WireRequest)
  }

  /** Fire an uncorrelated event to the other side's push subscribers. */
  push(channel: string, payload: unknown): void {
    if (this.disposedWith) return
    this.post({ push: channel, payload } satisfies WirePush)
  }

  /** Serve incoming requests and notifications. At most one handler; last registration wins. */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /** Subscribe to pushes from the other side; returns an unsubscribe function. */
  onPush(handler: PushHandler): () => void {
    this.pushHandlers.push(handler)
    return () => {
      this.pushHandlers = this.pushHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * Tear the channel down (port closed, process died, coordinated shutdown): every pending
   * invoke rejects with the given reason, later invokes reject immediately, and any late
   * traffic from the dead peer is ignored.
   */
  dispose(reason: Error): void {
    if (this.disposedWith) return
    this.disposedWith = reason
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(reason)
  }

  /** How many invokes are still waiting for a response (observability + tests). */
  pendingCount(): number {
    return this.pending.size
  }

  private post(data: WireRequest | WirePush): void {
    this.port.postMessage(data)
  }

  private async handle(data: unknown): Promise<void> {
    if (this.disposedWith) return
    if (typeof data !== 'object' || data === null) return
    const msg = data as Partial<WireRequest & WireResponse & WirePush>

    if (msg.response === true && typeof msg.id === 'string') {
      const entry = this.pending.get(msg.id)
      if (!entry) return // late/duplicate response for a settled or disposed call
      this.pending.delete(msg.id) // delete before settling -> exactly once
      if (msg.ok) entry.resolve(msg.value)
      else entry.reject(new Error(msg.error?.message ?? 'core request failed'))
      return
    }

    if (typeof msg.push === 'string') {
      for (const handler of [...this.pushHandlers]) {
        try {
          handler(msg.push, msg.payload)
        } catch (err) {
          console.error('[portRpc] push subscriber threw:', err)
        }
      }
      return
    }

    if (typeof msg.channel === 'string') {
      const handler = this.requestHandler
      const args = Array.isArray(msg.args) ? msg.args : []
      if (typeof msg.id !== 'string') {
        // Notification: run the handler, but failures have nowhere to go except the log.
        try {
          await handler?.(msg.channel, args)
        } catch (err) {
          console.error(`[portRpc] notification handler failed for ${msg.channel}:`, err)
        }
        return
      }
      let response: WireResponse
      try {
        if (!handler) throw new Error(`no request handler for ${msg.channel}`)
        response = { id: msg.id, ok: true, value: await handler(msg.channel, args), response: true }
      } catch (err) {
        // A throwing handler must still answer, otherwise the caller's invoke hangs forever.
        response = {
          id: msg.id,
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
          response: true
        }
      }
      if (!this.disposedWith) this.post(response as unknown as WireRequest | WirePush)
      return
    }
  }
}
