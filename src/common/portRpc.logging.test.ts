import { describe, expect, it, vi } from 'vitest'
import { createLogger } from './logging/logger'
import { PortRpc, type RpcPort } from './portRpc'

/** A pair of ports wired straight to each other, so a request really round-trips. */
function portPair(): [RpcPort, RpcPort] {
  const handlers: Array<Array<(msg: { data: unknown }) => void>> = [[], []]
  const make = (self: 0 | 1): RpcPort => ({
    postMessage: (data) => {
      for (const h of handlers[self === 0 ? 1 : 0]) h({ data })
    },
    on: (_event, handler) => void handlers[self].push(handler)
  })
  return [make(0), make(1)]
}

import { fakeSink, readRecords } from './logging/testSink'

describe('PortRpc logging', () => {
  it('logs a served request at debug with its channel and duration', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => 'ok')
    await caller.invoke('workspaces:getState', [])
    const served = readRecords(sink).find((r) => r.msg === 'rpc served')
    expect(served).toMatchObject({ level: 'debug', scope: 'rpc' })
    expect((served?.data as { channel: string }).channel).toBe('workspaces:getState')
    expect((served?.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs a rejected request at error with the stack', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => {
      throw new Error('handler blew up')
    })
    await expect(caller.invoke('todo:list', [])).rejects.toThrow('handler blew up')
    const failed = readRecords(sink).find((r) => r.msg === 'rpc failed')
    expect(failed).toMatchObject({ level: 'error' })
    expect((failed?.err as { message: string }).message).toBe('handler blew up')
    expect((failed?.err as { stack?: string }).stack).toBeDefined()
  })

  it('summarises arguments by shape, never by value', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => null)
    await caller.invoke('todo:add', ['buy milk', null])
    const served = readRecords(sink).find((r) => r.msg === 'rpc served')
    expect((served?.data as { args: string[] }).args).toEqual(['string(8)', 'null'])
    expect(sink.lines.join()).not.toContain('buy milk')
  })

  it('does not log a successful notification', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => undefined)
    caller.notify('terminal:input', ['s1', 'ls -la\r'])
    await Promise.resolve()
    expect(sink.lines).toEqual([])
  })

  it('logs a served request based on message kind, not its channel name', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => 'ok')
    await caller.invoke('terminal:input', ['s1', 'ls -la\r'])
    expect(readRecords(sink).find((r) => r.msg === 'rpc served')).toMatchObject({
      data: { channel: 'terminal:input' }
    })
  })

  it('does not log a successful push', () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const receiver = new PortRpc(a, {
      logger: createLogger({ sink, level: 'debug', proc: 'main', scope: 'rpc' })
    })
    const sender = new PortRpc(b)
    receiver.onPush(() => undefined)
    sender.push('terminal:data', { sessionId: 's1', data: 'hello' })
    expect(sink.lines).toEqual([])
  })

  it('logs a failing notification, which has nowhere else to surface', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => {
      throw new Error('notify failed')
    })
    caller.notify('terminal:kill', ['s1'])
    await vi.waitFor(() => expect(readRecords(sink).some((r) => r.level === 'error')).toBe(true))
  })

  it('works exactly as before with no logger supplied', async () => {
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b)
    server.onRequest(async () => 'fine')
    await expect(caller.invoke('todo:list', [])).resolves.toBe('fine')
  })
})
