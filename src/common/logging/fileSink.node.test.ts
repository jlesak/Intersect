import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileSink, dailyLogFileName, pruneOldLogs } from './fileSink.node'

/**
 * Every descriptor the sink closes, in order. A descriptor number is reusable the instant it is
 * closed, so closing one twice is the sink reaching outside itself: the second close lands on
 * whatever the process opened in between.
 */
const closed = vi.hoisted(() => [] as number[])

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    closeSync: (fd: number) => {
      closed.push(fd)
      return actual.closeSync(fd)
    }
  }
})

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intersect-logsink-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  closed.length = 0
})

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('dailyLogFileName', () => {
  it('names the file after the UTC day', () => {
    expect(dailyLogFileName(new Date('2026-07-28T23:59:59.000Z'))).toBe('intersect-2026-07-28.jsonl')
  })
})

describe('createFileSink', () => {
  it('creates the directory and appends one line per record', () => {
    const dir = join(scratch(), 'logs')
    const sink = createFileSink({ dir, now: () => new Date('2026-07-28T00:00:00.000Z') })
    sink.write('{"a":1}')
    sink.write('{"b":2}')
    sink.close()
    const body = readFileSync(join(dir, 'intersect-2026-07-28.jsonl'), 'utf8')
    expect(body).toBe('{"a":1}\n{"b":2}\n')
  })

  it('appends to an existing file rather than truncating it', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'intersect-2026-07-28.jsonl'), '{"pre":true}\n')
    const sink = createFileSink({ dir, now: () => new Date('2026-07-28T10:00:00.000Z') })
    sink.write('{"post":true}')
    sink.close()
    expect(readFileSync(join(dir, 'intersect-2026-07-28.jsonl'), 'utf8')).toBe(
      '{"pre":true}\n{"post":true}\n'
    )
  })

  it('rolls onto the next day without being told', () => {
    const dir = scratch()
    let clock = new Date('2026-07-28T23:59:59.000Z')
    const sink = createFileSink({ dir, now: () => clock })
    sink.write('{"day":28}')
    clock = new Date('2026-07-29T00:00:01.000Z')
    sink.write('{"day":29}')
    sink.close()
    expect(readdirSync(dir).sort()).toEqual([
      'intersect-2026-07-28.jsonl',
      'intersect-2026-07-29.jsonl'
    ])
  })

  /**
   * A rollover that fails after the day's descriptor is closed must not leave the sink holding a
   * number the OS has already handed to somebody else. The core opens descriptors from libuv's
   * threadpool - SQLite, the PTYs, the MCP child's pipes - while the blocking `mkdirSync` in this
   * path runs, so a second close on the freed number takes down unrelated I/O with EBADF.
   */
  it('never closes a descriptor twice when the day rolls over onto an unusable directory', () => {
    const dir = join(scratch(), 'logs')
    const onFailure = vi.fn()
    let clock = new Date('2026-07-28T23:59:59.000Z')
    const sink = createFileSink({ dir, now: () => clock, onFailure })
    sink.write('{"day":28}')
    expect(closed).toEqual([])

    // The directory becomes a plain file, so the reopen on the next day cannot succeed.
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'in the way')
    clock = new Date('2026-07-29T00:00:01.000Z')
    expect(() => sink.write('{"day":29}')).not.toThrow()
    expect(onFailure).toHaveBeenCalledTimes(1)

    // Closing the dead sink afterwards must not reach for it either.
    sink.close()
    expect(closed).toHaveLength(new Set(closed).size)
  })

  it('reports an unwritable directory once and then goes quiet', () => {
    const onFailure = vi.fn()
    // A path whose parent is a file cannot become a directory.
    const file = join(scratch(), 'occupied')
    writeFileSync(file, 'x')
    const sink = createFileSink({ dir: join(file, 'logs'), onFailure })
    expect(() => sink.write('{"a":1}')).not.toThrow()
    expect(() => sink.write('{"b":2}')).not.toThrow()
    expect(onFailure).toHaveBeenCalledTimes(1)
  })
})

describe('pruneOldLogs', () => {
  it('removes only log files past the retention window', () => {
    const dir = scratch()
    for (const name of [
      'intersect-2026-07-10.jsonl',
      'intersect-2026-07-27.jsonl',
      'intersect-2026-07-28.jsonl'
    ]) {
      writeFileSync(join(dir, name), '')
    }
    writeFileSync(join(dir, 'unrelated.txt'), '')
    const removed = pruneOldLogs(dir, new Date('2026-07-28T12:00:00.000Z'), 7)
    expect(removed).toEqual(['intersect-2026-07-10.jsonl'])
    expect(readdirSync(dir).sort()).toEqual([
      'intersect-2026-07-27.jsonl',
      'intersect-2026-07-28.jsonl',
      'unrelated.txt'
    ])
  })

  it('says nothing was removed when the directory is absent', () => {
    expect(pruneOldLogs(join(scratch(), 'missing'), new Date(), 7)).toEqual([])
  })
})
