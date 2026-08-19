import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initRendererLogging, rendererLogger } from './logger'

const written: unknown[] = []

beforeEach(() => {
  written.length = 0
  ;(window as unknown as { intersect: unknown }).intersect = {
    log: { write: (record: unknown) => void written.push(record) }
  }
})

function records(): Array<Record<string, unknown>> {
  return written as Array<Record<string, unknown>>
}

describe('initRendererLogging', () => {
  it('ships records through the preload bridge stamped as the renderer', () => {
    initRendererLogging().child('renderer').error('something broke')
    expect(records()[0]).toMatchObject({ proc: 'renderer', level: 'error', msg: 'something broke' })
  })

  it('records an uncaught error reaching window.onerror', () => {
    initRendererLogging()
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        filename: 'a.js',
        lineno: 3,
        error: new Error('boom')
      })
    )
    const rec = records().find((r) => r.msg === 'uncaught error')
    expect(rec).toMatchObject({ level: 'error' })
    expect((rec?.err as { message: string }).message).toBe('boom')
  })

  it('records an unhandled rejection', () => {
    initRendererLogging()
    // jsdom does not fire PromiseRejectionEvent on its own, so dispatch it directly.
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new Error('dangling')
    window.dispatchEvent(event)
    expect(records().some((r) => r.msg === 'unhandled rejection')).toBe(true)
  })

  it('mirrors a library console.error into the log', () => {
    const native = { error: vi.fn(), warn: vi.fn() }
    initRendererLogging({ console: native })
    console.error('React key warning')
    expect(records().some((r) => r.msg === 'console.error')).toBe(true)
    // The original console still receives the call, so devtools is unchanged.
    expect(native.error).toHaveBeenCalledWith('React key warning')
  })

  /**
   * The mirror is installed over a global every library calls, so it is the one call site in the
   * app that cannot be allowed to throw. A value with no usable primitive conversion is ordinary in
   * a Vite renderer - a module namespace object is one - and stringifying it is the first thing the
   * mirror does, upstream of every guard the logger has.
   */
  it('describes an argument that cannot be stringified instead of throwing at the caller', () => {
    const native = { error: vi.fn(), warn: vi.fn() }
    initRendererLogging({ console: native })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile: Array<[string, unknown]> = [
      ['null-prototype', Object.create(null)],
      [
        'throwing toString',
        {
          toString() {
            throw new Error('nope')
          }
        }
      ],
      ['revoked proxy', revoked.proxy]
    ]
    for (const [label, value] of hostile) {
      expect(() => console.error(label, value), label).not.toThrow()
    }
    const mirrored = records().filter((r) => r.msg === 'console.error')
    expect(mirrored).toHaveLength(3)
    for (const record of mirrored) {
      expect((record.data as { args: string[] }).args[1]).toContain('unprintable')
    }
    // The native console still saw every call, so devtools output is unaffected by the failure.
    expect(native.error).toHaveBeenCalledTimes(3)
  })

  it('does not recurse when the sink itself logs to console', () => {
    ;(window as unknown as { intersect: unknown }).intersect = {
      log: {
        write: () => {
          console.error('sink is broken')
        }
      }
    }
    const native = { error: vi.fn(), warn: vi.fn() }
    initRendererLogging({ console: native })
    expect(() => console.error('first')).not.toThrow()
  })

  it('survives a missing preload bridge', () => {
    delete (window as unknown as { intersect?: unknown }).intersect
    expect(() => initRendererLogging().error('no bridge')).not.toThrow()
  })
})

describe('rendererLogger', () => {
  it('returns the initialised instance', () => {
    const created = initRendererLogging()
    expect(rendererLogger()).toBe(created)
  })
})
