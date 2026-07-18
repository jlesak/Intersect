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

import {
  disposeSession,
  ensureSession,
  markAllInterrupted,
  respawnInterrupted,
  setCoreSpawnGate
} from './terminalController'
import { useInterruptedStore } from './interruptedStore'

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
  setCoreSpawnGate(true)
  useInterruptedStore.setState({ interrupted: {} })
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

describe('core crash interruption', () => {
  test('markAllInterrupted writes the notice, flags the session, and silences its sink', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('int:one', 'shell', '/repo')

    markAllInterrupted('background services restarted')

    expect(useInterruptedStore.getState().interrupted['int:one']).toBe(true)
    expect(written().some((w) => w.includes('background services restarted - session interrupted'))).toBe(
      true
    )
    // Bytes arriving for the dead PTY (late or from a confused source) must never render.
    routeData({ sessionId: 'int:one', data: 'ZOMBIE', seq: 99 })
    expect(written().some((w) => w.includes('ZOMBIE'))).toBe(false)
  })

  test('an interrupted session is never auto-respawned by ensureSession', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('int:stay', 'shell', '/repo')
    markAllInterrupted('background services restarted')
    vi.clearAllMocks()

    await ensureSession('int:stay', 'shell', '/repo')

    expect(ipcMock.attach).not.toHaveBeenCalled()
    expect(ipcMock.spawn).not.toHaveBeenCalled()
    expect(useInterruptedStore.getState().interrupted['int:stay']).toBe(true)
  })

  test('respawnInterrupted reuses the xterm, spawns with the resume id, and restores live output', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: 'OLD', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('int:resume', 'claude', '/repo')
    markAllInterrupted('background services restarted')

    await respawnInterrupted('int:resume', 'claude', '/repo', 'resume-9')

    expect(ipcMock.spawn).toHaveBeenCalledTimes(1)
    const [id, preset, cwd, , , resumeSessionId] = ipcMock.spawn.mock.calls[0] as unknown[]
    expect([id, preset, cwd, resumeSessionId]).toEqual(['int:resume', 'claude', '/repo', 'resume-9'])
    expect(useInterruptedStore.getState().interrupted['int:resume']).toBeUndefined()
    routeData({ sessionId: 'int:resume', data: 'FRESH', seq: 1 })
    expect(written().some((w) => w.includes('FRESH'))).toBe(true)
  })

  test('respawnInterrupted is a no-op for a session that is not interrupted', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('int:healthy', 'shell', '/repo')
    vi.clearAllMocks()

    await respawnInterrupted('int:healthy', 'shell', '/repo')

    expect(ipcMock.spawn).not.toHaveBeenCalled()
  })

  test('disposing an interrupted session clears its flag', async () => {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession('int:gone', 'shell', '/repo')
    markAllInterrupted('background services restarted')

    disposeSession('int:gone')

    expect(useInterruptedStore.getState().interrupted['int:gone']).toBeUndefined()
  })
})

describe('spawn gate', () => {
  test('a failed attach waits for the core to be ready before spawning', async () => {
    setCoreSpawnGate(false)
    ipcMock.attach.mockRejectedValue(new Error('core restarting'))

    const creation = ensureSession('gate:wait', 'shell', '/repo')
    await Promise.resolve()
    await Promise.resolve()
    expect(ipcMock.spawn).not.toHaveBeenCalled()

    setCoreSpawnGate(true)
    await creation
    expect(ipcMock.spawn).toHaveBeenCalledTimes(1)
  })

  test('a session interrupted while waiting at the gate never spawns', async () => {
    setCoreSpawnGate(false)
    ipcMock.attach.mockRejectedValue(new Error('core restarting'))

    const creation = ensureSession('gate:interrupted', 'shell', '/repo')
    // Let the failed attach materialize the view, then interrupt it while the gate is shut.
    await vi.waitFor(() => {
      markAllInterrupted('background services restarted')
      expect(useInterruptedStore.getState().interrupted['gate:interrupted']).toBe(true)
    })

    setCoreSpawnGate(true)
    await creation
    expect(ipcMock.spawn).not.toHaveBeenCalled()
  })
})
