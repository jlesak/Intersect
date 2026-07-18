import { describe, expect, test, vi } from 'vitest'
import { PortRpc } from './portRpc'

// Build a linked pair of in-memory ports that forward postMessage to the other side's
// 'message' listeners - a minimal stand-in for the real MessageChannelMain that wires
// Electron main to the core utility process.
interface PairPort {
  postMessage(data: unknown): void
  on(event: 'message', handler: (msg: { data: unknown }) => void): void
  start(): void
}

function makePortPair(): { portA: PairPort; portB: PairPort } {
  const aHandlers: ((msg: { data: unknown }) => void)[] = []
  const bHandlers: ((msg: { data: unknown }) => void)[] = []
  const portA = {
    postMessage: (data: unknown) => {
      for (const h of bHandlers) h({ data })
    },
    on: (_e: 'message', h: (msg: { data: unknown }) => void) => {
      aHandlers.push(h)
    },
    start: () => {}
  }
  const portB = {
    postMessage: (data: unknown) => {
      for (const h of aHandlers) h({ data })
    },
    on: (_e: 'message', h: (msg: { data: unknown }) => void) => {
      bHandlers.push(h)
    },
    start: () => {}
  }
  return { portA, portB }
}

function makeLinkedRpcs(): { client: PortRpc; server: PortRpc } {
  const { portA, portB } = makePortPair()
  return { client: new PortRpc(portA), server: new PortRpc(portB) }
}

describe('PortRpc request/response', () => {
  test('resolves invoke with the handler result on success', async () => {
    const { client, server } = makeLinkedRpcs()
    server.onRequest(async (channel, args) => ({ channel, args }))

    await expect(client.invoke('todo:add', ['buy milk', null])).resolves.toEqual({
      channel: 'todo:add',
      args: ['buy milk', null]
    })
  })

  test('rejects invoke when the request handler throws - never hangs', async () => {
    const { client, server } = makeLinkedRpcs()
    server.onRequest(async () => {
      throw new Error('task is locked')
    })

    await expect(client.invoke('todo:add', [])).rejects.toThrow('task is locked')
  })

  test('does not leave a stale pending entry after a rejected request', async () => {
    const { client, server } = makeLinkedRpcs()
    let calls = 0
    server.onRequest(async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return 'ok'
    })

    await expect(client.invoke('x', [])).rejects.toThrow('boom')
    expect(client.pendingCount()).toBe(0)
    await expect(client.invoke('x', [])).resolves.toBe('ok')
    expect(client.pendingCount()).toBe(0)
  })

  test('normalizes a non-Error throw into a message-only Error', async () => {
    const { client, server } = makeLinkedRpcs()
    server.onRequest(async () => {
      throw 'plain string failure'
    })

    await expect(client.invoke('x', [])).rejects.toThrow('plain string failure')
  })

  test('correlates concurrent requests answered out of order', async () => {
    const { client, server } = makeLinkedRpcs()
    const gates = new Map<string, () => void>()
    server.onRequest(async (_channel, args) => {
      const [name] = args as [string]
      await new Promise<void>((resolve) => gates.set(name, resolve))
      return `result:${name}`
    })

    const first = client.invoke('x', ['first'])
    const second = client.invoke('x', ['second'])
    expect(client.pendingCount()).toBe(2)

    // Answer in reverse order; each caller must still get its own result.
    gates.get('second')!()
    await expect(second).resolves.toBe('result:second')
    gates.get('first')!()
    await expect(first).resolves.toBe('result:first')
    expect(client.pendingCount()).toBe(0)
  })
})

describe('PortRpc notifications', () => {
  test('notify reaches the request handler without creating a pending entry', async () => {
    const { client, server } = makeLinkedRpcs()
    const seen: Array<{ channel: string; args: unknown[] }> = []
    server.onRequest(async (channel, args) => {
      seen.push({ channel, args })
    })

    client.notify('terminal:input', ['s1', 'ls\r'])
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ channel: 'terminal:input', args: ['s1', 'ls\r'] })
    expect(client.pendingCount()).toBe(0)
  })

  test('a throwing handler on a notification does not post a response', async () => {
    const { portA, portB } = makePortPair()
    const posted: unknown[] = []
    const spyPortB = {
      ...portB,
      postMessage: (data: unknown) => {
        posted.push(data)
        portB.postMessage(data)
      }
    }
    const client = new PortRpc(portA)
    const server = new PortRpc(spyPortB)
    server.onRequest(async () => {
      throw new Error('notification handler failure')
    })

    client.notify('terminal:input', ['s1', 'x'])
    // Give the async handler a tick to run; nothing must cross back.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(posted).toHaveLength(0)
  })
})

describe('PortRpc push delivery', () => {
  test('delivers pushes to every subscriber and supports unsubscribe', () => {
    const { client, server } = makeLinkedRpcs()
    const a: unknown[] = []
    const b: unknown[] = []
    const offA = client.onPush((channel, payload) => a.push([channel, payload]))
    client.onPush((channel, payload) => b.push([channel, payload]))

    server.push('terminal:data', { sessionId: 's1', data: 'hi' })
    expect(a).toEqual([['terminal:data', { sessionId: 's1', data: 'hi' }]])
    expect(b).toEqual([['terminal:data', { sessionId: 's1', data: 'hi' }]])

    offA()
    server.push('terminal:data', { sessionId: 's1', data: 'again' })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  test('one throwing push subscriber does not starve the others', () => {
    const { client, server } = makeLinkedRpcs()
    const seen: unknown[] = []
    client.onPush(() => {
      throw new Error('subscriber bug')
    })
    client.onPush((channel) => seen.push(channel))

    server.push('usage:changed', null)
    expect(seen).toEqual(['usage:changed'])
  })
})

describe('PortRpc disposal (process death / shutdown)', () => {
  test('dispose rejects every pending invoke and clears the pending map', async () => {
    const { client, server } = makeLinkedRpcs()
    server.onRequest(() => new Promise(() => {})) // never answers

    const first = client.invoke('x', [])
    const second = client.invoke('y', [])
    expect(client.pendingCount()).toBe(2)

    client.dispose(new Error('core process exited with code 1'))
    await expect(first).rejects.toThrow('core process exited with code 1')
    await expect(second).rejects.toThrow('core process exited with code 1')
    expect(client.pendingCount()).toBe(0)
  })

  test('invoke after dispose rejects immediately', async () => {
    const { client } = makeLinkedRpcs()
    client.dispose(new Error('gone'))
    await expect(client.invoke('x', [])).rejects.toThrow('gone')
    expect(client.pendingCount()).toBe(0)
  })

  test('a late response after dispose is ignored', async () => {
    const { portA, portB } = makePortPair()
    const client = new PortRpc(portA)
    let answer: (() => void) | null = null
    const server = new PortRpc(portB)
    server.onRequest(async () => {
      await new Promise<void>((resolve) => {
        answer = resolve
      })
      return 'late'
    })

    const call = client.invoke('x', [])
    client.dispose(new Error('gone'))
    await expect(call).rejects.toThrow('gone')

    answer!()
    // Flush the server's async response; the disposed client must not blow up
    // and must not resurrect pending state.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.pendingCount()).toBe(0)
  })

  test('a duplicate response settles the caller exactly once', async () => {
    const { portA } = makePortPair()
    // Drive the client against a hand-rolled server that answers twice.
    const clientPort = {
      postMessage: (data: unknown) => {
        const req = data as { id: string }
        // Answer the same request twice, second time with an error.
        deliver({ id: req.id, ok: true, value: 'first', response: true })
        deliver({ id: req.id, ok: false, error: { message: 'second' }, response: true })
      },
      on: (_e: 'message', h: (msg: { data: unknown }) => void) => {
        handlers.push(h)
      },
      start: portA.start
    }
    const handlers: ((msg: { data: unknown }) => void)[] = []
    const deliver = (data: unknown): void => {
      for (const h of handlers) h({ data })
    }
    const client = new PortRpc(clientPort)

    await expect(client.invoke('x', [])).resolves.toBe('first')
    expect(client.pendingCount()).toBe(0)
  })

  test('push after dispose is not delivered', () => {
    const { client, server } = makeLinkedRpcs()
    const seen: unknown[] = []
    client.onPush((channel) => seen.push(channel))
    client.dispose(new Error('gone'))
    server.push('usage:changed', null)
    expect(seen).toEqual([])
  })
})
