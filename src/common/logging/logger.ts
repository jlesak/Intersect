/**
 * The logger every process constructs over its own sink: level filtering, scope tagging, error
 * normalisation, and the rate guard that keeps a log storm from wedging the app.
 *
 * All I/O is injected as a `LogSink`, which is what keeps this module pure enough to unit-test and
 * lets main, core, and the renderer share one implementation over three very different transports.
 *
 * Nothing here may throw into a caller and nothing here may change control flow. A logging call is a
 * diagnostic aside: if it fails, the operation it was meant to explain still has to run.
 */

import {
  isLevelEnabled,
  LEVEL_ORDER,
  normalizeError,
  serialize,
  type LogLevel,
  type LogProc,
  type LogRecord,
  type LogScope
} from './record'

/**
 * Where serialised records go. Every process injects its own, which is what keeps the logger
 * itself free of I/O and unit-testable.
 */
export interface LogSink {
  write(line: string): void
}

/**
 * The optional payload of one call. Structured parameters belong in `data` so that `msg` stays
 * constant for a given event and the file can be grouped by it; `err` accepts whatever was thrown
 * and is normalised on the way in.
 */
export interface LogFields {
  data?: Record<string, unknown>
  err?: unknown
}

export interface Logger {
  error(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  /** A logger identical to this one but tagged with a different subsystem. */
  child(scope: LogScope): Logger
}

export interface LoggerOptions {
  sink: LogSink
  level: LogLevel
  proc: LogProc
  pid?: number
  scope?: LogScope
  now?: () => Date
  /** Ceiling per rolling second, shared with every child. */
  maxRecordsPerSecond?: number
  /** Called once, the first time the sink throws. */
  onSinkFailure?: (err: unknown) => void
}

export const DEFAULT_MAX_RECORDS_PER_SECOND = 500

const WINDOW_MS = 1000

/** Mutable state every logger in a tree shares, so a child cannot win itself a fresh budget. */
interface SharedState {
  dead: boolean
  windowStart: number
  inWindow: number
  dropped: number
}

/**
 * Read a configured level name, falling back whenever the value is absent or is anything other than
 * one of the four declared levels. The check is an own-property one so that a name the object
 * inherits, such as `constructor`, is rejected like any other unrecognised value; treating it as a
 * level would produce an order of `undefined` and silently disable every record in the process.
 */
export function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  return raw !== undefined && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)
    ? (raw as LogLevel)
    : fallback
}

export function createLogger(opts: LoggerOptions): Logger {
  const now = opts.now ?? ((): Date => new Date())
  const pid = opts.pid ?? process.pid
  const cap = opts.maxRecordsPerSecond ?? DEFAULT_MAX_RECORDS_PER_SECOND
  const shared: SharedState = { dead: false, windowStart: now().getTime(), inWindow: 0, dropped: 0 }

  /**
   * Hand one record to the sink, or account for it as dropped. A sink that throws is reported
   * once and then abandoned: logging is diagnostics, and diagnostics must never take the app down.
   */
  const emit = (record: LogRecord): void => {
    if (shared.dead) return
    try {
      opts.sink.write(serialize(record))
    } catch (err) {
      shared.dead = true
      opts.onSinkFailure?.(err)
    }
  }

  /**
   * Enforce the per-second ceiling. Excess is counted rather than written, and the count surfaces
   * as one record when the next window opens - so a log storm stays visible as a storm instead of
   * either wedging the process or vanishing.
   */
  const admit = (at: number): boolean => {
    if (at - shared.windowStart >= WINDOW_MS) {
      const dropped = shared.dropped
      shared.windowStart = at
      shared.inWindow = 0
      shared.dropped = 0
      if (dropped > 0) {
        shared.inWindow += 1
        emit({
          ts: new Date(at).toISOString(),
          level: 'warn',
          proc: opts.proc,
          pid,
          scope: 'log',
          msg: 'log rate limit exceeded',
          data: { dropped, windowMs: WINDOW_MS }
        })
      }
    }
    if (shared.inWindow >= cap) {
      shared.dropped += 1
      return false
    }
    shared.inWindow += 1
    return true
  }

  const build = (scope: LogScope): Logger => {
    const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (!isLevelEnabled(level, opts.level)) return
      const at = now()
      if (!admit(at.getTime())) return
      const record: LogRecord = { ts: at.toISOString(), level, proc: opts.proc, pid, scope, msg }
      if (fields?.data !== undefined) record.data = fields.data
      if (fields?.err !== undefined) record.err = normalizeError(fields.err)
      emit(record)
    }

    return {
      error: (msg, fields) => write('error', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      debug: (msg, fields) => write('debug', msg, fields),
      child: (next) => build(next)
    }
  }

  return build(opts.scope ?? 'lifecycle')
}
