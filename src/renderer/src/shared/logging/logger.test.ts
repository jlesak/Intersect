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
