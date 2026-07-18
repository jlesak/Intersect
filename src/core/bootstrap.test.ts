import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NATIVE_DOCK_BADGE_PUSH, WINDOW_FOCUS_CHANGED } from '@common/coreBridge'
import { Channel } from '@common/ipc'
import type { PtyProcess, SpawnFn } from './pty/sessionManager'
import { buildMarker, PERMISSION_TOKEN, STOP_TOKEN } from './pty/attentionMarkers'
import { readListenerSidecar } from './hooks/listenerSidecar'
import { createCoreRuntime, type CoreRuntime } from './bootstrap'

/** A recording PTY fake: enough surface for the session manager, no native module. */
function makeFakeSpawn(): { spawn: SpawnFn; procs: FakeProc[]; envs: Record<string, string>[] } {
  const procs: FakeProc[] = []
  const envs: Record<string, string>[] = []
  const spawn: SpawnFn = (req) => {
    const proc = makeFakeProc()
    procs.push(proc)
    envs.push(req.env)
    return proc.pty
  }
  return { spawn, procs, envs }
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

  const boot = (env: NodeJS.ProcessEnv = {}): CoreRuntime => {
    runtime = createCoreRuntime({
      userDataDir: dir,
      execPath: process.execPath,
      env: { INTERSECT_E2E: '1', INTERSECT_HOOK_PORT_RANGE: '18100-18119', ...env },
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

  describe('hook lifecycle', () => {
    /** Wait until the runtime's async listener bind published its sidecar, then read it. */
    const listenerInfo = async (): Promise<{ port: number; token: string }> => {
      const sidecarPath = join(dir, 'listener.json')
      await vi.waitFor(() => {
        if (!existsSync(sidecarPath)) throw new Error('sidecar not written yet')
      })
      const sidecar = readListenerSidecar(sidecarPath)
      if (!sidecar) throw new Error('unreadable sidecar')
      return { port: sidecar.port, token: readFileSync(join(dir, 'hook-token'), 'utf8').trim() }
    }

    const postHook = (
      port: number,
      event: string,
      headers: Record<string, string>,
      body: unknown
    ): Promise<number> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/hooks/${event}`,
            agent: false,
            headers: { 'content-type': 'application/json', ...headers }
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end(payload)
      })

    const spawnClaudeTab = async (
      rt: CoreRuntime
    ): Promise<{ sessionId: string; wsId: string; tabId: string }> => {
      const ws = (await rt.handleRequest(Channel.workspacesCreate, [dir, 'ws'])) as { id: string }
      const tab = (await rt.handleRequest(Channel.tabsCreate, [ws.id, 'claude', null])) as {
        id: string
      }
      const sessionId = `${ws.id}:${tab.id}`
      await rt.handleRequest(Channel.terminalSpawn, [sessionId, 'claude', dir, 80, 24, null])
      return { sessionId, wsId: ws.id, tabId: tab.id }
    }

    test('injects the session id as INTERSECT_INSTANCE_ID into the claude spawn env only', async () => {
      const rt = boot()
      const { sessionId, wsId } = await spawnClaudeTab(rt)
      expect(fake.envs[0].INTERSECT_INSTANCE_ID).toBe(sessionId)

      const shellTab = (await rt.handleRequest(Channel.tabsCreate, [wsId, 'shell', null])) as {
        id: string
      }
      await rt.handleRequest(Channel.terminalSpawn, [
        `${wsId}:${shellTab.id}`,
        'shell',
        dir,
        80,
        24,
        null
      ])
      expect(fake.envs[1].INTERSECT_INSTANCE_ID).toBeUndefined()
    })

    test('an authenticated permission hook drives the waiting status with risk metadata', async () => {
      const rt = boot()
      const { sessionId } = await spawnClaudeTab(rt)
      const { port, token } = await listenerInfo()

      const status = await postHook(
        port,
        'NotificationPermission',
        { authorization: `Bearer ${token}`, 'x-intersect-instance': sessionId },
        { cwd: dir, message: 'Claude needs your permission to use Bash' }
      )
      expect(status).toBe(204)
      const statusPush = pushes.find((p) => p.channel === Channel.terminalSessionStatus)
      expect(statusPush?.payload).toEqual({ sessionId, status: 'waiting', risk: 'unknown' })
      const badgePush = pushes.find((p) => p.channel === NATIVE_DOCK_BADGE_PUSH)
      expect(badgePush?.payload).toEqual({ count: 1 })
    })

    test('a wrong bearer token is rejected and produces no status change', async () => {
      const rt = boot()
      const { sessionId } = await spawnClaudeTab(rt)
      const { port } = await listenerInfo()

      const status = await postHook(
        port,
        'Stop',
        { authorization: 'Bearer wrong', 'x-intersect-instance': sessionId },
        { cwd: dir }
      )
      expect(status).toBe(401)
      expect(pushes.find((p) => p.channel === Channel.terminalSessionStatus)).toBeUndefined()
    })

    test('SessionStart persists the captured claude session UUID onto the tab row', async () => {
      const rt = boot()
      const { sessionId, wsId, tabId } = await spawnClaudeTab(rt)
      const { port, token } = await listenerInfo()

      await postHook(
        port,
        'SessionStart',
        { authorization: `Bearer ${token}`, 'x-intersect-instance': sessionId },
        { session_id: 'claude-uuid-1', cwd: dir }
      )
      const tabs = (await rt.handleRequest(Channel.tabsListByWorkspace, [wsId])) as {
        id: string
        resumeSessionId: string | null
      }[]
      expect(tabs.find((t) => t.id === tabId)?.resumeSessionId).toBe('claude-uuid-1')
    })

    test('a nested different-cwd SessionStart cannot alter the tab resume id or state', async () => {
      const rt = boot()
      const { sessionId, wsId, tabId } = await spawnClaudeTab(rt)
      const { port, token } = await listenerInfo()

      const status = await postHook(
        port,
        'SessionStart',
        { authorization: `Bearer ${token}`, 'x-intersect-instance': sessionId },
        { session_id: 'foreign-uuid', cwd: '/private/tmp' }
      )
      expect(status).toBe(204)
      const tabs = (await rt.handleRequest(Channel.tabsListByWorkspace, [wsId])) as {
        id: string
        resumeSessionId: string | null
      }[]
      expect(tabs.find((t) => t.id === tabId)?.resumeSessionId).toBeNull()
      expect(pushes.find((p) => p.channel === Channel.terminalSessionStatus)).toBeUndefined()
    })

    test('hooks win conflicts: once hook events flow, PTY markers are ignored for the session', async () => {
      const rt = boot()
      const { sessionId } = await spawnClaudeTab(rt)
      const { port, token } = await listenerInfo()

      await postHook(
        port,
        'Stop',
        { authorization: `Bearer ${token}`, 'x-intersect-instance': sessionId },
        { cwd: dir }
      )
      const donePushes = pushes.filter((p) => p.channel === Channel.terminalSessionStatus)
      expect(donePushes).toHaveLength(1)
      expect(donePushes[0].payload).toEqual({ sessionId, status: 'done' })

      // The helper also prints the marker for Stop; the now hook-healthy session must not
      // process it a second time through the fallback detector.
      fake.procs[0].emitData(buildMarker(STOP_TOKEN))
      fake.procs[0].emitData(buildMarker(PERMISSION_TOKEN))
      expect(pushes.filter((p) => p.channel === Channel.terminalSessionStatus)).toHaveLength(1)
    })

    test('without hook events the marker fallback works even when no listener port binds', async () => {
      // Occupy the single allowed port so the runtime's listener cannot bind at all.
      const blocker = http.createServer(() => {})
      await new Promise<void>((r) => blocker.listen(18150, '127.0.0.1', () => r()))
      try {
        const rt = boot({ INTERSECT_HOOK_PORT_RANGE: '18150-18150' })
        const { sessionId } = await spawnClaudeTab(rt)
        // Boot survives, no sidecar appears, and the marker path still drives attention.
        fake.procs[0].emitData(buildMarker(PERMISSION_TOKEN))
        const statusPush = pushes.find((p) => p.channel === Channel.terminalSessionStatus)
        expect(statusPush?.payload).toEqual({ sessionId, status: 'waiting' })
        expect(existsSync(join(dir, 'listener.json'))).toBe(false)
      } finally {
        await new Promise<void>((r) => blocker.close(() => r()))
      }
    })

    test('shutdown stops the listener so its port is released', async () => {
      const rt = boot()
      await spawnClaudeTab(rt)
      const { port } = await listenerInfo()
      rt.shutdown()
      await expect(
        postHook(port, 'Stop', { authorization: 'Bearer x', 'x-intersect-instance': 'i' }, {})
      ).rejects.toThrow()
    })

    test('duplicate hook events do not stack duplicate attention', async () => {
      const rt = boot()
      const { sessionId } = await spawnClaudeTab(rt)
      const { port, token } = await listenerInfo()
      const auth = { authorization: `Bearer ${token}`, 'x-intersect-instance': sessionId }

      await postHook(port, 'Stop', auth, { cwd: dir })
      await postHook(port, 'Stop', auth, { cwd: dir })
      await postHook(port, 'NotificationIdle', auth, { cwd: dir, message: 'idle' })
      // One badge increment in total: repeats and the idle backstop map to the same 'done'.
      const badgePushes = pushes.filter((p) => p.channel === NATIVE_DOCK_BADGE_PUSH)
      expect(badgePushes).toHaveLength(1)
      expect(badgePushes[0].payload).toEqual({ count: 1 })
    })
  })
})
