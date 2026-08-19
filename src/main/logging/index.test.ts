import { describe, expect, it } from 'vitest'
import { RENDERER_LOG_CHANNEL } from '@common/logging/channel'
import { fakeSink, readRecords } from '@common/logging/testSink'
import {
  createMainLogger,
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
    createMainLogger({ userDataDir: '/tmp/x', env: {}, sink }).info('window opened')
    expect(readRecords(sink)[0]).toMatchObject({ proc: 'main' })
  })
})

describe('registerRendererLogReceiver', () => {
  it('appends a well-formed renderer record verbatim', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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

  it('ignores a non-object payload without throwing', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: mainSink })
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
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
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
