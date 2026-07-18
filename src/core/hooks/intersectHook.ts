// The non-blocking hook helper Claude Code runs for every lifecycle event of a managed
// session, bundled to out/main/hookHelper.js and invoked from the generated per-session
// settings as:
//   ELECTRON_RUN_AS_NODE=1 '<electron binary>' '<this file>' '<supportDir>' <event>
// It reads the hook's JSON payload from stdin, POSTs it to the app's localhost hook
// listener (port and bearer token discovered from files under the given support dir), and
// tags the request with the managed session's instance id inherited via the environment.
// For the events that map to the legacy PTY attention markers it ALSO prints Claude Code's
// `{"terminalSequence": ...}` contract to stdout, so the marker fallback keeps working
// whenever the listener is down. The prime directive: never delay or break Claude - stdin
// reading is capped at 150 ms, the POST at 200 ms, and EVERY path exits 0.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { IDLE_TOKEN, PERMISSION_TOKEN, STOP_TOKEN } from '../pty/attentionMarkers'

const ESC = '\u001b'
const BEL = '\u0007'

/** The events that double as PTY attention markers, and the token each one prints. */
const MARKER_TOKEN_BY_EVENT: Record<string, string> = {
  NotificationIdle: IDLE_TOKEN,
  NotificationPermission: PERMISSION_TOKEN,
  Stop: STOP_TOKEN
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    // Hard cap: whatever arrived within 150 ms is the payload. Claude must never wait on us.
    setTimeout(() => resolve(data), 150).unref()
  })
}

function extractMessage(raw: string): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { message?: unknown }
    return typeof parsed.message === 'string' && parsed.message.length > 0
      ? parsed.message
      : undefined
  } catch {
    return undefined
  }
}

/** Print the legacy OSC 9 attention marker so the PTY fallback still sees this event. */
function printMarker(token: string, body: string): void {
  const message = extractMessage(body)
  const payload = message ? ';' + Buffer.from(message, 'utf8').toString('base64') : ''
  const sequence = ESC + ']9;' + token + payload + BEL
  process.stdout.write(JSON.stringify({ terminalSequence: sequence }))
}

function post(port: number, token: string, event: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/hooks/${event}`,
        timeout: 200,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-intersect-instance': process.env.INTERSECT_INSTANCE_ID ?? '',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve())
      }
    )
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.write(body)
    req.end()
  })
}

async function main(): Promise<void> {
  const supportDir = process.argv[2]
  const event = process.argv[3]
  if (!supportDir || !event) process.exit(0)

  const body = await readStdin()

  // Marker first: it must reach stdout even when the listener discovery below fails,
  // because the marker IS the degraded path for exactly that failure.
  const markerToken = MARKER_TOKEN_BY_EVENT[event]
  if (markerToken) printMarker(markerToken, body)

  let token = ''
  let port = 0
  try {
    token = readFileSync(path.join(supportDir, 'hook-token'), 'utf8').trim()
    const sidecar = JSON.parse(
      readFileSync(path.join(supportDir, 'listener.json'), 'utf8')
    ) as { port?: number }
    port = Number(sidecar.port)
  } catch {
    process.exit(0)
  }
  if (!token || !port) process.exit(0)

  await post(port, token, event, body)
  process.exit(0)
}

void main()
