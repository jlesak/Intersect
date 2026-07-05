import { beforeEach, describe, expect, test } from 'vitest'
import type { Preset } from '@common/domain'
import { createSessionManager, type PtyProcess, type SpawnRequest } from './sessionManager'
import type { SpawnSpec } from './shell'

interface FakePty extends PtyProcess {
  emit(data: string): void
  writes: string[]
  killed: boolean
}

function makeFakePty(): FakePty {
  const dataCbs: ((d: string) => void)[] = []
  const exitCbs: ((e: { exitCode: number }) => void)[] = []
  const pty: FakePty = {
    pid: 4242,
    writes: [],
    killed: false,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (d) => pty.writes.push(d),
    resize: () => {},
    kill: () => {
      pty.killed = true
      exitCbs.forEach((cb) => cb({ exitCode: 0 }))
    },
    emit: (d) => dataCbs.forEach((cb) => cb(d))
  }
  return pty
}

function harness() {
  const spawned: { req: SpawnRequest; pty: FakePty }[] = []
  const sent = { data: [] as { sessionId: string; data: string }[], exit: [] as { sessionId: string; exitCode: number }[] }
  const spec: SpawnSpec = { file: '/bin/zsh', args: ['-f'], initialCommand: null, env: { TERM: 'x' } }
  const claudeSpec: SpawnSpec = { ...spec, initialCommand: 'claude' }

  const mgr = createSessionManager({
    spawn: (req) => {
      const pty = makeFakePty()
      spawned.push({ req, pty })
      return pty
    },
    send: {
      data: (e) => sent.data.push(e),
      exit: (e) => sent.exit.push(e)
    },
    buildSpec: (preset: Preset) => (preset === 'claude' ? claudeSpec : spec),
    fileExists: () => true,
    homedir: () => '/home/test'
  })
  return { mgr, spawned, sent }
}

describe('sessionManager', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  test('spawn launches a pty rooted at the given cwd with the built spec', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 120, 30)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].req).toMatchObject({ file: '/bin/zsh', args: ['-f'], cwd: '/repo', cols: 120, rows: 30 })
  })

  test('spawn is idempotent for a live session', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    expect(h.spawned).toHaveLength(1)
  })

  test('forwards pty output to the renderer keyed by sessionId', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.spawned[0].pty.emit('hello')
    expect(h.sent.data).toContainEqual({ sessionId: 'w1:t1', data: 'hello' })
  })

  test('claude preset types claude exactly once, on the first output', () => {
    h.mgr.spawn('w1:t1', 'claude', '/repo', 80, 24)
    const pty = h.spawned[0].pty
    pty.emit('prompt> ')
    pty.emit('more output')
    expect(pty.writes.filter((w) => w === 'claude\r')).toHaveLength(1)
  })

  test('shell preset never types an initial command', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    const pty = h.spawned[0].pty
    pty.emit('prompt> ')
    expect(pty.writes).toEqual([])
  })

  test('pty exit removes the session and notifies the renderer', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.spawned[0].pty.emit('x')
    h.spawned[0].pty.kill()
    expect(h.sent.exit).toContainEqual({ sessionId: 'w1:t1', exitCode: 0 })
    // session is gone: a fresh spawn creates a new pty
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    expect(h.spawned).toHaveLength(2)
  })

  test('write / resize / kill are no-ops on an unknown session', () => {
    expect(() => h.mgr.write('ghost', 'x')).not.toThrow()
    expect(() => h.mgr.resize('ghost', 10, 10)).not.toThrow()
    expect(() => h.mgr.kill('ghost')).not.toThrow()
  })

  test('killWorkspace kills only sessions with the workspace prefix', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.mgr.spawn('w1:t2', 'shell', '/repo', 80, 24)
    h.mgr.spawn('w2:t1', 'shell', '/repo', 80, 24)
    const [a, b, c] = h.spawned.map((s) => s.pty)
    h.mgr.killWorkspace('w1')
    expect([a.killed, b.killed, c.killed]).toEqual([true, true, false])
  })

  test('killAll kills every session', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.mgr.spawn('w2:t1', 'shell', '/repo', 80, 24)
    h.mgr.killAll()
    expect(h.spawned.every((s) => s.pty.killed)).toBe(true)
  })

  test('missing cwd falls back to home and warns in the terminal', () => {
    const spawned: { req: SpawnRequest }[] = []
    const notices: string[] = []
    const mgr = createSessionManager({
      spawn: (req) => {
        spawned.push({ req })
        return makeFakePty()
      },
      send: { data: (e) => notices.push(e.data), exit: () => {} },
      buildSpec: () => ({ file: '/bin/zsh', args: ['-l'], initialCommand: null, env: {} }),
      fileExists: () => false,
      homedir: () => '/home/test'
    })
    mgr.spawn('w1:t1', 'shell', '/deleted/repo', 80, 24)
    expect(spawned[0].req.cwd).toBe('/home/test')
    expect(notices.join('')).toMatch(/not found/i)
  })

  test('pause and resume send XOFF / XON to the pty', () => {
    h.mgr.spawn('w1:t1', 'shell', '/repo', 80, 24)
    h.mgr.pause('w1:t1')
    h.mgr.resume('w1:t1')
    expect(h.spawned[0].pty.writes).toEqual(['\x13', '\x11'])
  })
})
