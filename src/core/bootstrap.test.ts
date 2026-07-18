import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { NATIVE_DOCK_BADGE_PUSH, WINDOW_FOCUS_CHANGED } from '@common/coreBridge'
import { Channel } from '@common/ipc'
import type { PtyProcess, SpawnFn } from './pty/sessionManager'
import { buildMarker, PERMISSION_TOKEN } from './pty/attentionMarkers'
import { createCoreRuntime, type CoreRuntime } from './bootstrap'

/** A recording PTY fake: enough surface for the session manager, no native module. */
function makeFakeSpawn(): { spawn: SpawnFn; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  const spawn: SpawnFn = () => {
    const proc = makeFakeProc()
    procs.push(proc)
    return proc.pty
  }
  return { spawn, procs }
}

interface FakeProc {
  pty: PtyProcess
  calls: string[]
  emitData(chunk: string): void
  emitExit(code: number): void
}

function makeFakeProc(): FakeProc {
  const calls: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((e: { exitCode: number }) => void) | null = null
  return {
    calls,
    emitData: (chunk) => onData?.(chunk),
    emitExit: (code) => onExit?.({ exitCode: code }),
    pty: {
      pid: 4242,
      onData: (cb) => {
        onData = cb
      },
      onExit: (cb) => {
        onExit = cb
      },
      write: (data) => calls.push(`write:${data}`),
      resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
      kill: () => calls.push('kill')
    }
  }
}

describe('createCoreRuntime', () => {
  let dir: string
  let pushes: Array<{ channel: string; payload: unknown }>
  let fake: ReturnType<typeof makeFakeSpawn>
  let runtime: CoreRuntime | null

  const boot = (): CoreRuntime => {
    runtime = createCoreRuntime({
      userDataDir: dir,
      execPath: process.execPath,
      env: { INTERSECT_E2E: '1' },
      emitPush: (channel, payload) => pushes.push({ channel, payload }),
      spawn: fake.spawn,
      ensureSpawnHelper: () => {},
      applyLoginShellPath: () => Promise.resolve()
    })
    return runtime
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-core-test-'))
    pushes = []
    fake = makeFakeSpawn()
    runtime = null
  })

  afterEach(() => {
    runtime?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  test('boots against an empty user-data dir and serves a first request', async () => {
    const rt = boot()
    const state = (await rt.handleRequest(Channel.workspacesGetState, [])) as {
      workspaces: unknown[]
    }
    expect(Array.isArray(state.workspaces)).toBe(true)
  })

  test('serves slice requests end to end through the composed routes', async () => {
    const rt = boot()
    const added = (await rt.handleRequest(Channel.todoAdd, ['write the core', null])) as {
      id: string
      text: string
    }
    expect(added.text).toBe('write the core')
    const lists = (await rt.handleRequest(Channel.todoList, [])) as { open: { id: string }[] }
    expect(lists.open.map((t) => t.id)).toEqual([added.id])
  })

  test('rejects an unknown channel and an Electron-only channel', async () => {
    const rt = boot()
    await expect(rt.handleRequest('bogus:channel', [])).rejects.toThrow(
      'no core handler for channel'
    )
    await expect(rt.handleRequest(Channel.workspacesPickFolder, [])).rejects.toThrow(
      'no core handler for channel'
    )
  })

  test('spawns a PTY, streams data as pushes, and forwards the backpressure controls', async () => {
    const rt = boot()
    const ws = (await rt.handleRequest(Channel.workspacesCreate, [dir, 'test-ws'])) as {
      id: string
    }
    const tab = (await rt.handleRequest(Channel.tabsCreate, [ws.id, 'shell', null])) as {
      id: string
    }
    const sessionId = `${ws.id}:${tab.id}`
    const spawned = (await rt.handleRequest(Channel.terminalSpawn, [
      sessionId,
      'shell',
      dir,
      80,
      24,
      null
    ])) as { ok: boolean }
    expect(spawned.ok).toBe(true)
    expect(fake.procs).toHaveLength(1)

    fake.procs[0].emitData('hello from pty')
    expect(pushes).toContainEqual({
      channel: Channel.terminalData,
      payload: { sessionId, data: 'hello from pty' }
    })

    // The renderer's watermark pause/resume must reach the real child PTY.
    await rt.handleRequest(Channel.terminalPause, [sessionId])
    await rt.handleRequest(Channel.terminalResume, [sessionId])
    await rt.handleRequest(Channel.terminalInput, [sessionId, 'ls\r'])
    expect(fake.procs[0].calls).toEqual(['pause', 'resume', 'write:ls\r'])

    fake.procs[0].emitExit(0)
    expect(pushes).toContainEqual({
      channel: Channel.terminalExit,
      payload: { sessionId, exitCode: 0 }
    })
  })

  test('accepts the window focus notification from main', async () => {
    const rt = boot()
    await expect(
      rt.handleRequest(WINDOW_FOCUS_CHANGED, [{ focused: true }])
    ).resolves.toBeUndefined()
  })

  test('shutdown kills live PTYs, closes the DB, and is idempotent', async () => {
    const rt = boot()
    const ws = (await rt.handleRequest(Channel.workspacesCreate, [dir, 'ws'])) as { id: string }
    const tab = (await rt.handleRequest(Channel.tabsCreate, [ws.id, 'shell', null])) as {
      id: string
    }
    await rt.handleRequest(Channel.terminalSpawn, [`${ws.id}:${tab.id}`, 'shell', dir, 80, 24, null])

    rt.shutdown()
    expect(fake.procs[0].calls).toContain('kill')
    // The DB is closed: any data request now fails.
    await expect(rt.handleRequest(Channel.todoList, [])).rejects.toThrow()
    expect(() => rt.shutdown()).not.toThrow()
  })

  test('only the core opens the database: a second runtime on the same dir still boots (WAL), but main never does', () => {
    // Regression guard for the ownership rule: the runtime is the only production caller of
    // openDatabase. This is asserted structurally in lint (src/main cannot import core/db);
    // here we just prove the runtime owns open/close fully.
    const rt = boot()
    rt.shutdown()
    expect(() => boot()).not.toThrow()
  })

  test('a session status change surfaces the dock badge as a native push', async () => {
    const rt = boot()
    const ws = (await rt.handleRequest(Channel.workspacesCreate, [dir, 'ws'])) as { id: string }
    const tab = (await rt.handleRequest(Channel.tabsCreate, [ws.id, 'claude', null])) as {
      id: string
    }
    const sessionId = `${ws.id}:${tab.id}`
    await rt.handleRequest(Channel.terminalSpawn, [sessionId, 'claude', dir, 80, 24, null])

    // The attention marker used by the generated hook settings; emitting it flags the
    // session as waiting, which must push a status change and a badge count of 1.
    fake.procs[0].emitData(buildMarker(PERMISSION_TOKEN))
    const statusPush = pushes.find((p) => p.channel === Channel.terminalSessionStatus)
    const badgePush = pushes.find((p) => p.channel === NATIVE_DOCK_BADGE_PUSH)
    expect(statusPush?.payload).toMatchObject({ sessionId })
    expect(badgePush?.payload).toEqual({ count: 1 })
  })
})
