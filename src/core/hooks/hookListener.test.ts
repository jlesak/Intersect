import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PORT_RANGE,
  KNOWN_HOOK_EVENTS,
  resolvePortRange,
  startHookListener,
  type HookListenerHandle
} from './hookListener'

// Binds a real HTTP listener on a real port and makes real round-trips. Under heavy
// parallel-suite CPU contention this can exceed vitest's default timeout; give it headroom.
vi.setConfig({ testTimeout: 30_000 })

// A range far away from the production default so tests never collide with a running app.
const TEST_RANGE: [number, number] = [17621, 17640]

/**
 * Raw node:http POST helper. Used instead of fetch throughout: Node's undici sees
 * ECONNRESET when a server responds with a small payload then closes the connection, and
 * the production client (the hook helper) uses http.request anyway.
 */
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    // agent: false - each request gets a fresh socket, so a listener stop() closing pooled
    // keep-alive connections can never poison a later test's request.
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers, agent: false },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const AUTH = { authorization: 'Bearer test-token', 'x-intersect-instance': 'ws1:tab1' }

describe('hookListener', () => {
  let handle: HookListenerHandle
  let received: Array<{ event: string; body: unknown; instanceId: string }>

  beforeEach(async () => {
    received = []
    handle = await startHookListener({
      token: 'test-token',
      portRange: TEST_RANGE,
      onEvent: (event, body, instanceId) => {
        received.push({ event, body, instanceId })
      }
    })
  })

  afterEach(async () => {
    await handle.stop().catch(() => {})
  })

  it('binds to a port in range and reports it', () => {
    expect(handle.port).toBeGreaterThanOrEqual(TEST_RANGE[0])
    expect(handle.port).toBeLessThanOrEqual(TEST_RANGE[1])
  })

  it('accepts an authenticated event with an instance header (204) and parses the body', async () => {
    const { status } = await post(
      handle.port,
      '/hooks/NotificationPermission',
      AUTH,
      JSON.stringify({ session_id: 'abc', cwd: '/tmp', message: 'permission?' })
    )
    expect(status).toBe(204)
    expect(received).toHaveLength(1)
    expect(received[0].event).toBe('NotificationPermission')
    expect(received[0].instanceId).toBe('ws1:tab1')
    expect((received[0].body as { session_id: string }).session_id).toBe('abc')
  })

  it('accepts all seven allowlisted events', async () => {
    for (const event of KNOWN_HOOK_EVENTS) {
      const { status } = await post(handle.port, `/hooks/${event}`, AUTH, '{}')
      expect(status, event).toBe(204)
    }
    expect(received.map((r) => r.event)).toEqual([...KNOWN_HOOK_EVENTS])
  })

  it('rejects a wrong bearer token (401) without invoking the handler', async () => {
    const { status } = await post(
      handle.port,
      '/hooks/Stop',
      { ...AUTH, authorization: 'Bearer wrong' },
      '{}'
    )
    expect(status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('rejects a missing authorization header (401)', async () => {
    const { status } = await post(
      handle.port,
      '/hooks/Stop',
      { 'x-intersect-instance': 'ws1:tab1' },
      '{}'
    )
    expect(status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('rejects unknown event names (400)', async () => {
    const { status } = await post(handle.port, '/hooks/Whatever', AUTH, '{}')
    expect(status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects a non-hooks path (400)', async () => {
    const { status } = await post(handle.port, '/other/Stop', AUTH, '{}')
    expect(status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects requests without an instance header (400)', async () => {
    const { status } = await post(
      handle.port,
      '/hooks/Stop',
      { authorization: 'Bearer test-token' },
      '{}'
    )
    expect(status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects payloads larger than 32 KiB (413) without invoking the handler', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(33 * 1024) })
    const { status } = await post(handle.port, '/hooks/Stop', AUTH, big)
    expect(status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('passes a non-JSON body through as the raw string', async () => {
    const { status } = await post(handle.port, '/hooks/Stop', AUTH, '{"trunca')
    expect(status).toBe(204)
    expect(received[0].body).toBe('{"trunca')
  })

  it('answers 500 when the event handler throws', async () => {
    const failing = await startHookListener({
      token: 't',
      portRange: TEST_RANGE,
      onEvent: () => {
        throw new Error('boom')
      }
    })
    try {
      const { status } = await post(
        failing.port,
        '/hooks/Stop',
        { authorization: 'Bearer t', 'x-intersect-instance': 'i' },
        '{}'
      )
      expect(status).toBe(500)
    } finally {
      await failing.stop()
    }
  })

  it('skips an occupied port and binds the next one in range', async () => {
    const second = await startHookListener({
      token: 't',
      portRange: [handle.port, handle.port + 1],
      onEvent: () => {}
    })
    try {
      expect(second.port).toBe(handle.port + 1)
    } finally {
      await second.stop()
    }
  })

  it('fails when every port in range is taken', async () => {
    await expect(
      startHookListener({ token: 't', portRange: [handle.port, handle.port], onEvent: () => {} })
    ).rejects.toThrow(/no free hook-listener port/)
  })

  it('stop() releases the port so a new listener can bind it', async () => {
    const port = handle.port
    await handle.stop()
    const again = await startHookListener({
      token: 't',
      portRange: [port, port],
      onEvent: () => {}
    })
    try {
      expect(again.port).toBe(port)
    } finally {
      await again.stop()
    }
    // Rebind for the shared afterEach stop.
    handle = await startHookListener({ token: 'test-token', portRange: TEST_RANGE, onEvent: () => {} })
  })
})

describe('resolvePortRange', () => {
  it('defaults when no override is set', () => {
    expect(resolvePortRange({})).toEqual(DEFAULT_PORT_RANGE)
  })

  it('parses a valid start-end override', () => {
    expect(resolvePortRange({ INTERSECT_HOOK_PORT_RANGE: '18000-18009' })).toEqual([18000, 18009])
  })

  it('falls back on malformed or inverted overrides', () => {
    expect(resolvePortRange({ INTERSECT_HOOK_PORT_RANGE: 'nonsense' })).toEqual(DEFAULT_PORT_RANGE)
    expect(resolvePortRange({ INTERSECT_HOOK_PORT_RANGE: '9000-8000' })).toEqual(DEFAULT_PORT_RANGE)
  })
})
