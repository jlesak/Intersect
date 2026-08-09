import type { ISearchOptions } from '@xterm/addon-search'
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

// The search addon reaches into xterm's renderer to paint its decorations, which jsdom does not
// have; the controller's own contract is which call it makes with which options, so one shared
// stand-in stands for the addon every session loads.
type Search = (term: string, options?: ISearchOptions) => boolean

const searchMock = vi.hoisted(() => ({
  findNext: vi.fn<Search>(() => true),
  findPrevious: vi.fn<Search>(() => true),
  clearDecorations: vi.fn(),
  listeners: [] as Array<(event: { resultIndex: number; resultCount: number }) => void>
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = searchMock.findNext
    findPrevious = searchMock.findPrevious
    clearDecorations = searchMock.clearDecorations
    activate(): void {}
    dispose(): void {}
    onDidChangeResults(listener: (event: { resultIndex: number; resultCount: number }) => void) {
      searchMock.listeners.push(listener)
      return {
        dispose: () => {
          searchMock.listeners = searchMock.listeners.filter((l) => l !== listener)
        }
      }
    }
  }
}))

import {
  clearSessionSearch,
  disposeSession,
  ensureSession,
  findInSession,
  markAllInterrupted,
  onSessionSearchResults,
  respawnInterrupted,
  setCoreSpawnGate
} from './terminalController'
import { useFindStore } from './findStore'
import { useInterruptedStore } from './interruptedStore'
import { XTERM_SEARCH_DECORATIONS } from './theme'

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
  searchMock.listeners = []
  useInterruptedStore.setState({ interrupted: {} })
  useFindStore.setState({ open: {}, query: {}, focusToken: {} })
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

describe('find in scrollback', () => {
  /** A live session, ready to be searched. */
  async function searchable(sessionId: string): Promise<void> {
    ipcMock.attach.mockResolvedValue({ live: true, data: '', cols: 80, rows: 24, lastSeq: 0 })
    await ensureSession(sessionId, 'shell', '/repo')
    vi.clearAllMocks()
  }

  test('every search carries the decorations, or the addon reports no results at all', async () => {
    await searchable('find:decorated')

    findInSession('find:decorated', 'needle', 'next')
    findInSession('find:decorated', 'needle', 'previous')

    expect(searchMock.findNext).toHaveBeenCalledWith('needle', {
      decorations: XTERM_SEARCH_DECORATIONS,
      incremental: false
    })
    expect(searchMock.findPrevious).toHaveBeenCalledWith('needle', {
      decorations: XTERM_SEARCH_DECORATIONS,
      incremental: false
    })
  })

  test('typing expands the match under the caret; stepping backwards never does', async () => {
    await searchable('find:incremental')

    findInSession('find:incremental', 'nee', 'next', true)
    findInSession('find:incremental', 'nee', 'previous', true)

    expect(searchMock.findNext.mock.calls[0][1]).toMatchObject({ incremental: true })
    expect(searchMock.findPrevious.mock.calls[0][1]).toMatchObject({ incremental: false })
  })

  test('an emptied query ends the search instead of running one', async () => {
    await searchable('find:emptied')

    expect(findInSession('find:emptied', '', 'next', true)).toBe(false)
    expect(searchMock.findNext).not.toHaveBeenCalled()
    expect(searchMock.clearDecorations).toHaveBeenCalledTimes(1)
  })

  test('closing the bar takes the highlights off the terminal', async () => {
    await searchable('find:closed')

    clearSessionSearch('find:closed')

    expect(searchMock.clearDecorations).toHaveBeenCalledTimes(1)
  })

  test('a session that is gone answers a search with false and no addon call', async () => {
    expect(findInSession('find:missing', 'needle', 'next')).toBe(false)
    expect(searchMock.findNext).not.toHaveBeenCalled()
  })

  test('the result subscription reports the addon tally and can be dropped again', async () => {
    await searchable('find:results')
    const seen: Array<{ resultIndex: number; resultCount: number }> = []

    const off = onSessionSearchResults('find:results', (event) => seen.push(event))
    searchMock.listeners.forEach((l) => l({ resultIndex: 2, resultCount: 9 }))
    off()
    searchMock.listeners.forEach((l) => l({ resultIndex: 3, resultCount: 9 }))

    expect(seen).toEqual([{ resultIndex: 2, resultCount: 9 }])
  })

  test('subscribing to a session that is gone yields a disposer that does nothing', () => {
    const off = onSessionSearchResults('find:absent', () => {})

    expect(() => off()).not.toThrow()
  })

  test('disposing a session leaves no find bar and no query behind', async () => {
    await searchable('find:disposed')
    useFindStore.getState().openFind('find:disposed')
    useFindStore.getState().setQuery('find:disposed', 'needle')

    disposeSession('find:disposed')

    expect(useFindStore.getState().open['find:disposed']).toBeUndefined()
    expect(useFindStore.getState().query['find:disposed']).toBeUndefined()
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
