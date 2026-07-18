import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMarker, IDLE_TOKEN, PERMISSION_TOKEN, STOP_TOKEN } from '../pty/attentionMarkers'

// Each case runs the real helper as a `node` child process, exactly as Claude Code's hook
// would (modulo Electron's ELECTRON_RUN_AS_NODE, which just makes Electron behave as node).
// Cold-starting processes under heavy suite parallelism can exceed the default timeout.
vi.setConfig({ testTimeout: 30_000 })

/** Bundle the TS helper once with esbuild - the same bundling the production build applies. */
let helperJs = ''
let buildDir = ''

beforeAll(async () => {
  buildDir = mkdtempSync(path.join(tmpdir(), 'intersect-hook-build-'))
  helperJs = path.join(buildDir, 'hookHelper.js')
  const esbuild = await import('esbuild')
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'intersectHook.ts')],
    bundle: true,
    platform: 'node',
    outfile: helperJs,
    logLevel: 'silent'
  })
})

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true })
})

interface Received {
  url: string
  method: string
  auth: string | undefined
  instanceId: string | undefined
  body: string
}

interface RunResult {
  code: number | null
  stdout: string
  durationMs: number
}

function runHelper(
  args: string[],
  stdinJson: unknown,
  env: NodeJS.ProcessEnv
): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const proc = spawn(process.execPath, [helperJs, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    if (stdinJson !== undefined) {
      proc.stdin.write(typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson))
    }
    proc.stdin.end()
    proc.on('exit', (code) => resolve({ code, stdout, durationMs: Date.now() - startedAt }))
  })
}

describe('intersect hook helper', () => {
  let dir: string
  let server: http.Server
  let port = 0
  let received: Received[]

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'intersect-hook-'))
    received = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          method: req.method ?? '',
          auth: req.headers.authorization,
          instanceId: req.headers['x-intersect-instance'] as string | undefined,
          body
        })
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    if (!addr || typeof addr !== 'object') throw new Error('no address')
    port = addr.port
    writeFileSync(
      path.join(dir, 'listener.json'),
      JSON.stringify({ port, writtenAt: Date.now() }),
      { mode: 0o600 }
    )
    writeFileSync(path.join(dir, 'hook-token'), 'tok', { mode: 0o600 })
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards the payload to /hooks/<event> with bearer auth + instance header', async () => {
    const { code } = await runHelper(
      [dir, 'SessionStart'],
      { session_id: 'abc', cwd: '/repo' },
      { INTERSECT_INSTANCE_ID: 'ws1:tab1' }
    )
    expect(code).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/hooks/SessionStart')
    expect(received[0].method).toBe('POST')
    expect(received[0].auth).toBe('Bearer tok')
    expect(received[0].instanceId).toBe('ws1:tab1')
    expect(JSON.parse(received[0].body).session_id).toBe('abc')
  })

  it('prints the legacy PTY marker for the three marker events, with the message payload', async () => {
    const cases: Array<[string, string]> = [
      ['NotificationIdle', IDLE_TOKEN],
      ['NotificationPermission', PERMISSION_TOKEN],
      ['Stop', STOP_TOKEN]
    ]
    for (const [event, token] of cases) {
      const { code, stdout } = await runHelper([dir, event], { message: 'hello' }, {
        INTERSECT_INSTANCE_ID: 'i'
      })
      expect(code, event).toBe(0)
      expect(JSON.parse(stdout).terminalSequence, event).toBe(buildMarker(token, 'hello'))
    }
  })

  it('prints a bare marker when the payload carries no message (Stop hooks never do)', async () => {
    const { stdout } = await runHelper([dir, 'Stop'], {}, { INTERSECT_INSTANCE_ID: 'i' })
    expect(JSON.parse(stdout).terminalSequence).toBe(buildMarker(STOP_TOKEN))
  })

  it('prints nothing for non-marker events', async () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'PreToolUse']) {
      const { stdout } = await runHelper([dir, event], {}, { INTERSECT_INSTANCE_ID: 'i' })
      expect(stdout, event).toBe('')
    }
  })

  it('still prints the marker when the listener is unreachable (the fallback case), and exits 0', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    const { code, stdout, durationMs } = await runHelper(
      [dir, 'NotificationPermission'],
      { message: 'perm' },
      { INTERSECT_INSTANCE_ID: 'i' }
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout).terminalSequence).toBe(buildMarker(PERMISSION_TOKEN, 'perm'))
    // Bounded time: stdin is already closed and the POST fails fast on a dead port.
    expect(durationMs).toBeLessThan(5_000)
    // Rebind so afterEach's close has a live server.
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  })

  it('exits 0 when listener.json is missing (core never ran)', async () => {
    unlinkSync(path.join(dir, 'listener.json'))
    const { code, stdout } = await runHelper([dir, 'Stop'], {}, { INTERSECT_INSTANCE_ID: 'i' })
    expect(code).toBe(0)
    expect(JSON.parse(stdout).terminalSequence).toBe(buildMarker(STOP_TOKEN))
    expect(received).toHaveLength(0)
  })

  it('exits 0 when the token file is missing', async () => {
    unlinkSync(path.join(dir, 'hook-token'))
    const { code } = await runHelper([dir, 'Stop'], {}, { INTERSECT_INSTANCE_ID: 'i' })
    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('exits 0 when called without an event argument', async () => {
    const { code } = await runHelper([dir], {}, { INTERSECT_INSTANCE_ID: 'i' })
    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('exits 0 when called without any arguments', async () => {
    const { code } = await runHelper([], {}, {})
    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('exits 0 with malformed stdin, forwarding the raw body as-is', async () => {
    const { code } = await runHelper([dir, 'Stop'], 'not json {{{', {
      INTERSECT_INSTANCE_ID: 'i'
    })
    expect(code).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0].body).toBe('not json {{{')
  })

  it('sends an empty instance header when the env var is absent (nested-safe default)', async () => {
    const env = { ...process.env }
    delete env.INTERSECT_INSTANCE_ID
    const { code } = await new Promise<RunResult>((resolve) => {
      const proc = spawn(process.execPath, [helperJs, dir, 'Stop'], { env })
      let stdout = ''
      proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
      proc.stdin.end('{}')
      const startedAt = Date.now()
      proc.on('exit', (code) => resolve({ code, stdout, durationMs: Date.now() - startedAt }))
    })
    expect(code).toBe(0)
    expect(received[0].instanceId).toBe('')
  })

  it('completes in bounded time even when stdin never closes (the 150 ms cap)', async () => {
    const startedAt = Date.now()
    const code = await new Promise<number | null>((resolve) => {
      const proc = spawn(process.execPath, [helperJs, dir, 'Stop'], {
        env: { ...process.env, INTERSECT_INSTANCE_ID: 'i' }
      })
      // Write a partial payload and never end stdin - the helper must not wait for EOF.
      proc.stdin.write('{"partial":')
      proc.on('exit', (c) => resolve(c))
    })
    expect(code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    // The partial body was sent as-is.
    expect(received).toHaveLength(1)
    expect(received[0].body).toBe('{"partial":')
  })
})
