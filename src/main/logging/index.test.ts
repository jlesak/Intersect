import { describe, expect, it, vi } from 'vitest'
import { RENDERER_LOG_CHANNEL } from '@common/logging/channel'
import { REDACTED } from '@common/logging/record'
import { fakeSink, readRecords } from '@common/logging/testSink'
import {
  createMainLogger,
  installMainGlobalHandlers,
  registerRendererLogReceiver,
  type RendererLogReceiverDeps
} from './index'

/**
 * Captures the single handler the receiver registers so tests can drive it. Electron types `on` as
 * returning the emitter for chaining, which a plain capture has nothing to return, so the stub is
 * cast to the shape the receiver asks for.
 */
function fakeIpcMain(): RendererLogReceiverDeps['ipcMain'] & {
  emit: (channel: string, ...args: unknown[]) => void
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    on: ((channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      handlers.set(channel, handler)
    }) as never,
    emit: (channel, ...args) => handlers.get(channel)?.({}, ...args)
  }
}

describe('createMainLogger', () => {
  it('stamps every record as the main process', () => {
    const sink = fakeSink()
    createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }).info('window opened')
    expect(readRecords(sink)[0]).toMatchObject({ proc: 'main' })
  })

  it('honours INTERSECT_LOG_LEVEL', () => {
    const sink = fakeSink()
    const log = createMainLogger({
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
   * The floor is chosen from whether the app is packaged, which is something only the host can
   * report. Reading it from the environment instead put every packaged run on the development
   * floor, because nothing sets `NODE_ENV` in an app launched from the Dock.
   */
  it('defaults to info when packaged and debug otherwise', () => {
    const packaged = fakeSink()
    createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: true, sink: packaged }).debug('x')
    expect(packaged.lines).toEqual([])

    const dev = fakeSink()
    createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: dev }).debug('x')
    expect(dev.lines).toHaveLength(1)
  })
})

/**
 * Capture the listeners the installer registers rather than emitting on the real process, so a
 * test cannot hand vitest's own handlers an exception it never asked for.
 */
function captureProcessHandlers(): {
  handlers: Map<string, (...args: unknown[]) => void>
  restore(): void
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const spy = vi
    .spyOn(process, 'on')
    .mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
      return process
    }) as never)
  return { handlers, restore: () => spy.mockRestore() }
}

describe('installMainGlobalHandlers', () => {
  /**
   * Electron's own handler stands down the moment a second `uncaughtException` listener exists, so
   * installing one takes the native error box away unless the caller puts it back.
   */
  it('records an uncaught exception and then calls onFatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    const captured = captureProcessHandlers()
    installMainGlobalHandlers(
      createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }),
      onFatal
    )
    captured.restore()
    captured.handlers.get('uncaughtException')?.(new Error('kaboom'))
    const rec = readRecords(sink).find((r) => r.msg === 'uncaught exception')
    expect(rec).toMatchObject({ level: 'error' })
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect((onFatal.mock.calls[0][0] as Error).message).toBe('kaboom')
  })

  it('records an unhandled rejection without treating it as fatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    const captured = captureProcessHandlers()
    installMainGlobalHandlers(
      createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }),
      onFatal
    )
    captured.restore()
    captured.handlers.get('unhandledRejection')?.(new Error('dangling'))
    expect(readRecords(sink).some((r) => r.msg === 'unhandled rejection')).toBe(true)
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('logs the exception even when reporting it fails', () => {
    const sink = fakeSink()
    const captured = captureProcessHandlers()
    installMainGlobalHandlers(
      createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink }),
      () => {
        throw new Error('no window to show a dialog on')
      }
    )
    captured.restore()
    expect(() => captured.handlers.get('uncaughtException')?.(new Error('kaboom'))).not.toThrow()
    expect(readRecords(sink).some((r) => r.msg === 'uncaught exception')).toBe(true)
  })
})

describe('registerRendererLogReceiver', () => {
  it('appends a well-formed renderer record verbatim', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'error',
      proc: 'renderer',
      pid: 1,
      scope: 'renderer',
      msg: 'boundary caught a render failure'
    })
    expect(readRecords(sink)[0]).toMatchObject({
      proc: 'renderer',
      level: 'error',
      msg: 'boundary caught a render failure'
    })
  })

  it('rejects a record with an unknown level instead of writing it', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, { level: 'catastrophe', msg: 'x' })
    expect(sink.lines).toEqual([])
  })

  it('rejects a level name inherited from Object.prototype', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    for (const level of ['constructor', 'toString', 'valueOf']) {
      ipcMain.emit(RENDERER_LOG_CHANNEL, {
        ts: '2026-07-28T09:00:00.000Z',
        level,
        pid: 1,
        scope: 'renderer',
        msg: 'inherited'
      })
    }
    expect(sink.lines).toEqual([])
  })

  it('rejects a scope outside the declared union', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      pid: 1,
      scope: 'whatever',
      msg: 'x'
    })
    expect(sink.lines).toEqual([])
  })

  it('forces proc to renderer even if the payload claims otherwise', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      proc: 'core',
      pid: 9,
      scope: 'renderer',
      msg: 'spoofed'
    })
    expect(readRecords(sink)[0].proc).toBe('renderer')
  })

  /**
   * The sandboxed renderer cannot read the environment, so the configured floor would apply to two
   * producers of three. Main resolves it and owns the file, so it applies it to the records it
   * appends on the renderer's behalf.
   */
  it('drops a renderer record below the configured floor', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'error',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    const record = {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      pid: 1,
      scope: 'renderer',
      msg: 'renderer boot'
    }
    ipcMain.emit(RENDERER_LOG_CHANNEL, record)
    ipcMain.emit(RENDERER_LOG_CHANNEL, { ...record, level: 'warn', msg: 'console.warn' })
    expect(sink.lines).toEqual([])
    ipcMain.emit(RENDERER_LOG_CHANNEL, { ...record, level: 'error', msg: 'uncaught error' })
    expect(readRecords(sink).map((r) => r.msg)).toEqual(['uncaught error'])
  })

  /**
   * The renderer redacted its own record before serialising it, so main's pass finds the values
   * already replaced and writes no count of its own. Dropping the count it arrived with would make
   * a renderer that handles credentials look like one that never sees any.
   */
  it('keeps the redaction count the renderer record arrived with', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'error',
      pid: 1,
      scope: 'renderer',
      msg: 'toast failed',
      data: { url: `https://h/a?sig=${REDACTED}` },
      redactions: 1
    })
    expect(readRecords(sink)[0]).toMatchObject({ redactions: 1 })
  })

  it('ignores a redaction count that is not a whole number of markers', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    for (const redactions of [-1, 1.5, Number.NaN, '2']) {
      ipcMain.emit(RENDERER_LOG_CHANNEL, {
        ts: '2026-07-28T09:00:00.000Z',
        level: 'error',
        pid: 1,
        scope: 'renderer',
        msg: 'toast failed',
        redactions
      })
    }
    expect(readRecords(sink).every((r) => !('redactions' in r))).toBe(true)
  })

  it('ignores a non-object payload without throwing', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    expect(() => ipcMain.emit(RENDERER_LOG_CHANNEL, 'garbage')).not.toThrow()
    expect(sink.lines).toEqual([])
  })

  it('reports a malformed payload on the main logger', () => {
    const sink = fakeSink()
    const mainSink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: mainSink })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, null)
    expect(readRecords(mainSink)[0]).toMatchObject({ proc: 'main', level: 'warn', scope: 'log' })
  })

  it('swallows a sink that throws instead of surfacing it to the sender', () => {
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink: {
        write: () => {
          throw new Error('disk gone')
        }
      },
      level: 'debug',
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, packaged: false, sink: fakeSink() })
    })
    expect(() =>
      ipcMain.emit(RENDERER_LOG_CHANNEL, {
        ts: '2026-07-28T09:00:00.000Z',
        level: 'info',
        pid: 1,
        scope: 'renderer',
        msg: 'x'
      })
    ).not.toThrow()
  })
})
