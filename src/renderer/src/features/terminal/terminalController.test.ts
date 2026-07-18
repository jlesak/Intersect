import { Terminal } from '@xterm/xterm'
import { beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import type { TerminalAttachResult, TerminalDataEvent } from '@common/ipc'

const ipcMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve({ ok: true })),
  attach: vi.fn<(sessionId: string) => Promise<TerminalAttachResult>>(),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(() => () => {})
}))
vi.mock('./ipc', () => ipcMock)

import { disposeSession, ensureSession } from './terminalController'

// The one live onData listener the controller wires for the renderer's lifetime; captured so
// tests can inject pushes as if the core sent them.
let routeData: (event: TerminalDataEvent) => void

let writeSpy: MockInstance

beforeAll(() => {
  // jsdom has no ResizeObserver; the controller only needs the observe/disconnect surface.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ipcMock.onData.mockImplementation((cb: (event: TerminalDataEvent) => void) => {
    routeData = cb
    return () => {}
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  writeSpy = vi.spyOn(Terminal.prototype, 'write')
})

const written = (): string[] => writeSpy.mock.calls.map((c) => c[0] as string)

describe('ensureSession reattach flow', () => {
  test('a live attach seeds the xterm from the snapshot and never spawns', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: 'SNAPSHOT', cols: 100, rows: 40, lastSeq: 0 })

    await ensureSession('live:fresh', 'shell', '/repo')

    expect(ipcMock.attach).toHaveBeenCalledWith('live:fresh')
    expect(ipcMock.spawn).not.toHaveBeenCalled()
    expect(written()).toEqual(['SNAPSHOT'])
  })

  test('resets a possibly stuck pty pause after a live attach', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })

    await ensureSession('live:paused', 'shell', '/repo')

    expect(ipcMock.resume).toHaveBeenCalledWith('live:paused')
  })

  test('drops buffered chunks the snapshot contains and renders the newer ones once', async () => {
    let resolveAttach!: (r: TerminalAttachResult) => void
    ipcMock.attach.mockReturnValue(new Promise((r) => (resolveAttach = r)))

    const creation = ensureSession('live:race', 'shell', '/repo')
    // Pushes arriving mid round-trip: seq 1-2 are already inside the snapshot, seq 3 is not.
    routeData({ sessionId: 'live:race', data: 'dup-1', seq: 1 })
    routeData({ sessionId: 'live:race', data: 'dup-2', seq: 2 })
    routeData({ sessionId: 'live:race', data: 'fresh-3', seq: 3 })
    resolveAttach({ live: true, data: 'SNAP', cols: 80, rows: 24, lastSeq: 2 })
    await creation

    expect(written()).toEqual(['SNAP', 'fresh-3'])
  })

  test('live: false falls back to spawning exactly as before, buffered bytes intact', async () => {
    let resolveAttach!: (r: TerminalAttachResult) => void
    ipcMock.attach.mockReturnValue(new Promise((r) => (resolveAttach = r)))

    const creation = ensureSession('dead:fallback', 'claude', '/repo', 'resume-42')
    routeData({ sessionId: 'dead:fallback', data: 'early', seq: 1 })
    resolveAttach({ live: false })
    await creation

    expect(ipcMock.spawn).toHaveBeenCalledTimes(1)
    const [id, preset, cwd, cols, rows, resumeSessionId] = ipcMock.spawn.mock.calls[0] as unknown[]
    expect([id, preset, cwd, resumeSessionId]).toEqual(['dead:fallback', 'claude', '/repo', 'resume-42'])
    expect(cols).toBeGreaterThan(0)
    expect(rows).toBeGreaterThan(0)
    expect(ipcMock.resume).not.toHaveBeenCalled()
    expect(written()).toEqual(['early'])
  })

  test('an attach failure degrades to the spawn path', async () => {
    ipcMock.attach.mockRejectedValue(new Error('core restarting'))

    await ensureSession('err:fallback', 'shell', '/repo')

    expect(ipcMock.spawn).toHaveBeenCalledTimes(1)
  })

  test('concurrent ensureSession calls join the in-flight creation', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })

    const first = ensureSession('live:joined', 'shell', '/repo')
    const second = ensureSession('live:joined', 'shell', '/repo')
    await Promise.all([first, second])

    expect(ipcMock.attach).toHaveBeenCalledTimes(1)
    expect(ipcMock.spawn).not.toHaveBeenCalled()
  })

  test('a second ensureSession for a live view resolves without any IPC', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('live:settled', 'shell', '/repo')
    vi.clearAllMocks()

    await ensureSession('live:settled', 'shell', '/repo')

    expect(ipcMock.attach).not.toHaveBeenCalled()
    expect(ipcMock.spawn).not.toHaveBeenCalled()
  })

  test('disposeSession during the round-trip aborts the creation and kills the pty', async () => {
    let resolveAttach!: (r: TerminalAttachResult) => void
    ipcMock.attach.mockReturnValue(new Promise((r) => (resolveAttach = r)))

    const creation = ensureSession('live:doomed', 'shell', '/repo')
    disposeSession('live:doomed')
    resolveAttach({ live: true, data: 'SNAP', cols: 80, rows: 24, lastSeq: 0 })
    await creation

    expect(ipcMock.kill).toHaveBeenCalledWith('live:doomed')
    expect(ipcMock.spawn).not.toHaveBeenCalled()
    expect(written()).toEqual([])
  })
})
