import { describe, expect, it } from 'vitest'
import { createLogger } from '@common/logging/logger'
import { fakeSink, readRecords } from '@common/logging/testSink'
import { withPtySpawnLogging } from './spawnLogging'
import type { PtyProcess, SpawnFn } from './sessionManager'

/** A PTY fake with node-pty's multi-listener events, since the decorator adds one of its own. */
function fakeSpawn(pid = 4242): { spawn: SpawnFn; exit: (e: { exitCode: number; signal?: number }) => void } {
  const listeners: Array<(e: { exitCode: number; signal?: number }) => void> = []
  const proc: PtyProcess = {
    pid,
    onData: () => {},
    onExit: (cb) => void listeners.push(cb),
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {}
  }
  return {
    spawn: () => proc,
    exit: (e) => listeners.forEach((cb) => cb(e))
  }
}

const request = { file: '/bin/zsh', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24, env: {} }

function log(sink: ReturnType<typeof fakeSink>) {
  return createLogger({ sink, level: 'debug', proc: 'core', scope: 'pty' })
}

describe('withPtySpawnLogging', () => {
  it('records the command and pid of a child as it starts', () => {
    const sink = fakeSink()
    const fake = fakeSpawn(1337)
    withPtySpawnLogging(fake.spawn, log(sink))(request)
    expect(readRecords(sink)[0]).toMatchObject({
      level: 'info',
      scope: 'pty',
      msg: 'child process spawned',
      data: { command: '/bin/zsh', pid: 1337 }
    })
  })

  it('records a clean exit with its code', () => {
    const sink = fakeSink()
    const fake = fakeSpawn()
    withPtySpawnLogging(fake.spawn, log(sink))(request)
    fake.exit({ exitCode: 0 })
    expect(readRecords(sink)[1]).toMatchObject({
      level: 'info',
      msg: 'child process exited',
      data: { command: '/bin/zsh', pid: 4242, exitCode: 0 }
    })
  })

  /**
   * A child killed by a signal is the case the file exists for: "my terminal vanished" is
   * undiagnosable without the code and the signal that ended it.
   */
  it('records a death by signal at warn', () => {
    const sink = fakeSink()
    const fake = fakeSpawn()
    withPtySpawnLogging(fake.spawn, log(sink))(request)
    fake.exit({ exitCode: 137, signal: 9 })
    expect(readRecords(sink)[1]).toMatchObject({
      level: 'warn',
      msg: 'child process exited',
      data: { exitCode: 137, signal: 9 }
    })
  })

  it('leaves the caller its own exit event', () => {
    const sink = fakeSink()
    const fake = fakeSpawn()
    const proc = withPtySpawnLogging(fake.spawn, log(sink))(request)
    const seen: number[] = []
    proc.onExit(({ exitCode }) => void seen.push(exitCode))
    fake.exit({ exitCode: 3 })
    expect(seen).toEqual([3])
  })
})
