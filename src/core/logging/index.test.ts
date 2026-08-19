import { describe, expect, it, vi } from 'vitest'
import { createCoreLogger, installCoreGlobalHandlers } from './index'

import { fakeSink, readRecords } from '@common/logging/testSink'

describe('createCoreLogger', () => {
  it('stamps every record as the core process', () => {
    const sink = fakeSink()
    createCoreLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }).info('up')
    expect(readRecords(sink)[0]).toMatchObject({ proc: 'core' })
  })

  it('honours INTERSECT_LOG_LEVEL', () => {
    const sink = fakeSink()
    const log = createCoreLogger({
      userDataDir: '/tmp/x',
      env: { INTERSECT_LOG_LEVEL: 'error' },
      packaged: false,
      sink
    })
    log.warn('suppressed')
    log.error('kept')
    expect(readRecords(sink).map((r) => r.level)).toEqual(['error'])
  })

  /**
   * Whether the app is packaged is reported by the host through the init message. Reading it from
   * the environment instead put every packaged run on the development floor, because nothing sets
   * `NODE_ENV` in an app launched from the Dock.
   */
  it('defaults to info when packaged and debug otherwise', () => {
    const packaged = fakeSink()
    createCoreLogger({
      userDataDir: '/tmp/x',
      env: { NODE_ENV: 'production' },
      packaged: true,
      sink: packaged
    }).debug('x')
    expect(packaged.lines).toEqual([])

    const dev = fakeSink()
    createCoreLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: dev }).debug('x')
    expect(dev.lines).toHaveLength(1)
  })

  it('stays on the development floor when the environment claims production', () => {
    // `NODE_ENV` is unset in a packaged app and set in plenty of development shells, so it says
    // nothing about which of the two a run is.
    const sink = fakeSink()
    createCoreLogger({
      userDataDir: '/tmp/x',
      env: { NODE_ENV: 'production' },
      packaged: false,
      sink
    }).debug('x')
    expect(sink.lines).toHaveLength(1)
  })
})

describe('installCoreGlobalHandlers', () => {
  it('records an uncaught exception and then calls onFatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    const log = createCoreLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink })
    const before = process.listenerCount('uncaughtException')
    installCoreGlobalHandlers(log, onFatal)
    process.emit('uncaughtException', new Error('kaboom'))
    const rec = readRecords(sink).find((r) => r.msg === 'uncaught exception')
    expect(rec).toMatchObject({ level: 'error' })
    expect((rec?.err as { message: string }).message).toBe('kaboom')
    expect(onFatal).toHaveBeenCalledTimes(1)
    process.removeAllListeners('uncaughtException')
    expect(before).toBeGreaterThanOrEqual(0)
  })

  it('records an unhandled rejection without treating it as fatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    installCoreGlobalHandlers(createCoreLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }), onFatal)
    process.emit('unhandledRejection', new Error('dangling'), Promise.resolve())
    expect(readRecords(sink).some((r) => r.msg === 'unhandled rejection')).toBe(true)
    expect(onFatal).not.toHaveBeenCalled()
    process.removeAllListeners('unhandledRejection')
  })
})
