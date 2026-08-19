import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { LogSink } from './logger'

/**
 * The append-only file sink shared by Electron main and the headless core.
 *
 * Both processes open the same daily file with `O_APPEND` and write their own records. POSIX makes
 * such a write atomic with respect to other writers, so no coordination is needed and - unlike
 * routing records through a port - a process that is about to die still gets its last words onto
 * disk. The renderer cannot use this sink: it is sandboxed and has no filesystem access.
 */

export const LOG_DIR_NAME = 'logs'

export const DEFAULT_RETENTION_DAYS = 7

const FILE_PATTERN = /^intersect-(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface FileSinkOptions {
  dir: string
  now?: () => Date
  /** Invoked once if the sink cannot write; after that the sink is inert. */
  onFailure?: (err: unknown) => void
}

export interface FileSink extends LogSink {
  close(): void
}

/**
 * One file per UTC day. A date in the name means no writer ever renames or rolls a file another
 * writer holds open, which removes the rotation race between the two processes entirely.
 */
export function dailyLogFileName(now: Date): string {
  return `intersect-${now.toISOString().slice(0, 10)}.jsonl`
}

/**
 * Delete log files older than the retention window and report what went. Only Electron main calls
 * this, at startup: it outlives the core, so making it the sole owner avoids coordinating deletes.
 */
export function pruneOldLogs(
  dir: string,
  now: Date,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  const removed: string[] = []
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name)
    if (!match) continue
    if (Date.parse(`${match[1]}T00:00:00.000Z`) >= cutoff) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed.push(name)
    } catch {
      // A file we cannot delete is not worth failing startup over; it will be retried next launch.
    }
  }
  return removed
}

/**
 * Open the current day's file lazily and append one line per record.
 *
 * The descriptor is reopened whenever the UTC day turns over, so a long-running process follows the
 * daily filename without anyone telling it the date changed. A failure anywhere in that path is
 * reported once and then silences the sink for the rest of the process lifetime: a logger that
 * cannot write must still never throw into the code it was meant to explain.
 */
export function createFileSink(opts: FileSinkOptions): FileSink {
  const now = opts.now ?? ((): Date => new Date())
  let fd: number | null = null
  let openName: string | null = null
  let dead = false

  const fail = (err: unknown): void => {
    dead = true
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already unusable; nothing further to do.
      }
      fd = null
    }
    opts.onFailure?.(err)
  }

  return {
    write(line) {
      if (dead) return
      try {
        const name = dailyLogFileName(now())
        if (name !== openName) {
          if (fd !== null) closeSync(fd)
          mkdirSync(opts.dir, { recursive: true })
          fd = openSync(join(opts.dir, name), 'a')
          openName = name
        }
        writeSync(fd!, `${line}\n`)
      } catch (err) {
        fail(err)
      }
    },
    close() {
      if (fd === null) return
      try {
        closeSync(fd)
      } catch {
        // Closing a broken descriptor changes nothing.
      }
      fd = null
      openName = null
    }
  }
}
