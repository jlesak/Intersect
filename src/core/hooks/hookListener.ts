import http from 'node:http'

/**
 * The lifecycle hook events the listener accepts, exactly as they appear in the generated
 * per-session settings. Anything else on the wire is rejected before domain handling.
 */
export const KNOWN_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'NotificationPermission',
  'NotificationIdle',
  'Stop',
  'SessionEnd',
  'PreToolUse'
] as const
export type HookEventName = (typeof KNOWN_HOOK_EVENTS)[number]

const KNOWN = new Set<string>(KNOWN_HOOK_EVENTS)

/** Hook payloads are small JSON blobs; anything bigger is garbage and gets a 413. */
const MAX_BODY = 32 * 1024

/** Header the helper tags each POST with, carrying the managed session's instance id. */
export const INSTANCE_HEADER = 'x-intersect-instance'

/** The localhost ports the listener tries in order; the sidecar publishes the winner. */
export const DEFAULT_PORT_RANGE: [number, number] = [7621, 7630]

/**
 * Resolve the port range from an `INTERSECT_HOOK_PORT_RANGE=start-end` override (tests use
 * this to avoid colliding with a running app), falling back to the default range.
 */
export function resolvePortRange(env: NodeJS.ProcessEnv): [number, number] {
  const raw = env.INTERSECT_HOOK_PORT_RANGE
  if (raw) {
    const match = /^(\d+)-(\d+)$/.exec(raw.trim())
    if (match) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (start > 0 && end >= start) return [start, end]
    }
  }
  return DEFAULT_PORT_RANGE
}

export interface HookListenerOptions {
  token: string
  portRange: [number, number]
  /** Called for every authenticated, allowlisted event; errors surface as a 500 response. */
  onEvent: (event: HookEventName, body: unknown, instanceId: string) => void
}

export interface HookListenerHandle {
  port: number
  stop(): Promise<void>
}

function respond(res: http.ServerResponse, status: number, error?: string): void {
  const body = error ? JSON.stringify({ error }) : ''
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * The authenticated localhost endpoint the hook helper posts lifecycle events to. Binds
 * 127.0.0.1 only, scanning the port range for a free slot (EADDRINUSE moves on; any other
 * bind error aborts). Every request must be a POST to `/hooks/<known event>` carrying the
 * bearer token and a non-empty instance header; bodies are hard-capped at 32 KiB (the
 * connection is destroyed past the cap so an attacker cannot stream unbounded data). A
 * body that is not valid JSON is passed through as a raw string - the caller decides how
 * much to trust it. `stop()` force-closes open connections so shutdown never hangs.
 */
export function startHookListener(opts: HookListenerOptions): Promise<HookListenerHandle> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false

    req.on('data', (chunk: Buffer) => {
      if (overflowed) return
      size += chunk.length
      if (size > MAX_BODY) {
        overflowed = true
        // Answer first, sever after: destroying before the 413 flushed would make the
        // client see a reset instead of the status. The destroy still guarantees an
        // endless stream cannot keep the socket occupied.
        res.once('finish', () => req.destroy())
        respond(res, 413, 'body too large')
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (overflowed) return
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        respond(res, 401, 'unauthorized')
        return
      }
      const match = req.method === 'POST' ? /^\/hooks\/([A-Za-z]+)$/.exec(req.url ?? '') : null
      const event = match?.[1]
      if (!event || !KNOWN.has(event)) {
        respond(res, 400, 'unknown event')
        return
      }
      const instanceId = String(req.headers[INSTANCE_HEADER] ?? '')
      if (!instanceId) {
        respond(res, 400, `missing ${INSTANCE_HEADER} header`)
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // Keep the raw string: the helper's stdin cap can truncate JSON mid-flight, and a
        // truncated event is still worth persisting as a diagnostic.
      }
      try {
        opts.onEvent(event as HookEventName, body, instanceId)
      } catch {
        respond(res, 500, 'internal')
        return
      }
      respond(res, 204)
    })

    req.on('error', () => {
      // A client that vanished mid-body needs no response; just stop accumulating.
      overflowed = true
    })
  })

  const [start, end] = opts.portRange

  const listenOn = (port: number): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') resolve(false)
        else reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })

  return (async () => {
    for (let port = start; port <= end; port++) {
      if (await listenOn(port)) {
        return {
          port,
          stop: () =>
            new Promise<void>((resolve, reject) => {
              server.close((err) => (err ? reject(err) : resolve()))
              server.closeAllConnections()
            })
        }
      }
    }
    throw new Error(`no free hook-listener port in range ${start}-${end}`)
  })()
}
