import { describe, expect, test, vi } from 'vitest'
import { createDataRouter } from './dataRouter'

describe('createDataRouter', () => {
  test('routes data only to the sink registered for its sessionId', () => {
    const router = createDataRouter()
    const a = vi.fn()
    const b = vi.fn()
    router.register('s1', a)
    router.register('s2', b)

    router.route({ sessionId: 's1', data: 'hello' })

    expect(a).toHaveBeenCalledWith('hello', undefined)
    expect(b).not.toHaveBeenCalled()
  })

  test('passes the chunk sequence number through to the sink', () => {
    const router = createDataRouter()
    const sink = vi.fn()
    router.register('s1', sink)

    router.route({ sessionId: 's1', data: 'x', seq: 7 })

    expect(sink).toHaveBeenCalledWith('x', 7)
  })

  test('no-ops for an unknown sessionId (late event after teardown)', () => {
    const router = createDataRouter()
    expect(() => router.route({ sessionId: 'ghost', data: 'x' })).not.toThrow()
  })

  test('dispose stops routing to that session', () => {
    const router = createDataRouter()
    const sink = vi.fn()
    router.register('s1', sink)
    router.dispose('s1')

    router.route({ sessionId: 's1', data: 'x' })

    expect(sink).not.toHaveBeenCalled()
  })

  test('re-registering a sessionId replaces the sink (rapid close/reopen)', () => {
    const router = createDataRouter()
    const first = vi.fn()
    const second = vi.fn()
    router.register('s1', first)
    router.register('s1', second)

    router.route({ sessionId: 's1', data: 'x' })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('x', undefined)
  })
})
