/**
 * The shape of one log line and the pure transformations every producer shares: level
 * comparison, error normalisation, secret redaction, and serialisation to a single JSON line.
 *
 * Redaction lives here rather than at the call sites so that no producer can forget it, and
 * serialisation is the only place a record's size is bounded.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type LogProc = 'main' | 'core' | 'renderer'

/**
 * The subsystem a record came from. A closed union rather than a free string so a typo fails the
 * build and grouping the log by subsystem stays reliable; adding a subsystem means adding a member.
 */
export type LogScope =
  | 'rpc'
  | 'http'
  | 'mcp'
  | 'db'
  | 'pty'
  | 'jira'
  | 'ado'
  | 'lifecycle'
  | 'attention'
  | 'agentRuntime'
  | 'oneOnOne'
  | 'settings'
  | 'renderer'
  | 'log'

export interface NormalizedError {
  name: string
  message: string
  stack?: string
  cause?: NormalizedError
}

export interface LogRecord {
  /** ISO 8601 with milliseconds. Producers append independently, so this is what re-orders the file. */
  ts: string
  level: LogLevel
  proc: LogProc
  pid: number
  scope: LogScope
  /** Short and stable for a given event, so the file can be grouped by it. Values belong in `data`. */
  msg: string
  data?: Record<string, unknown>
  err?: NormalizedError
}

export const REDACTED = '[redacted]'

export const MAX_RECORD_BYTES = 8192

/** Lower is more severe; a floor admits every level with an order at or below its own. */
export const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

const SECRET_KEY = /pat|token|cookie|password|secret|authorization|bearer|apikey/i

const MAX_STACK_CHARS = 2000

const MAX_CAUSE_DEPTH = 5

export function isLevelEnabled(level: LogLevel, floor: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[floor]
}

/**
 * Reduce anything throwable to a serialisable shape. Non-errors are described rather than
 * discarded, because a rejected promise carrying a string is exactly the case worth seeing.
 */
export function normalizeError(err: unknown, depth = 0): NormalizedError {
  if (!(err instanceof Error)) {
    return { name: typeof err, message: err === null ? 'null' : String(err) }
  }
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  const cause = (err as Error & { cause?: unknown }).cause
  // A cause that points back into the chain would recurse forever; depth is the cheap guard.
  if (cause !== undefined && cause !== err && depth < MAX_CAUSE_DEPTH) {
    out.cause = normalizeError(cause, depth + 1)
  }
  return out
}

/**
 * Deep copy with every secret-bearing key replaced. Cycles resolve to the marker string rather
 * than throwing, so a logging call can never fail because of the shape of what it was given.
 */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, seen)
  }
  return out
}

/**
 * Keep a URL useful for diagnosis while removing credentials carried in the query string.
 * A string that does not parse as a URL is returned as-is: it is not a credential carrier.
 */
export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, REDACTED)
  }
  return decodeURIComponent(url.toString())
}

/**
 * Describe call arguments by shape and size only. RPC arguments carry terminal keystrokes and
 * credentials, so their values must never reach the log.
 */
export function summarizeArgs(args: unknown[]): string[] {
  return args.map((arg) => {
    if (arg === null) return 'null'
    if (Array.isArray(arg)) return `array(${arg.length})`
    if (typeof arg === 'string') return `string(${arg.length})`
    return typeof arg
  })
}

interface WireRecord extends Omit<LogRecord, 'data' | 'err'> {
  data?: unknown
  err?: NormalizedError
}

function toWire(record: LogRecord): WireRecord {
  const wire: WireRecord = {
    ts: record.ts,
    level: record.level,
    proc: record.proc,
    pid: record.pid,
    scope: record.scope,
    msg: record.msg
  }
  if (record.data !== undefined) wire.data = redactValue(record.data)
  if (record.err !== undefined) wire.err = record.err
  return wire
}

function bytes(line: string): number {
  return Buffer.byteLength(line, 'utf8')
}

/**
 * Render one record as a single JSON line, redacted and size-bounded.
 *
 * An oversized record is shrunk in stages rather than dropped: the stack is clamped first, then
 * the structured fields are replaced by a marker carrying their original size. Staying well inside
 * the atomic-append limit is what keeps three processes writing one file from interleaving a
 * partial line.
 */
export function serialize(record: LogRecord): string {
  const wire = toWire(record)
  let line = JSON.stringify(wire)
  if (bytes(line) <= MAX_RECORD_BYTES) return line

  if (wire.err?.stack && wire.err.stack.length > MAX_STACK_CHARS) {
    wire.err = { ...wire.err, stack: `${wire.err.stack.slice(0, MAX_STACK_CHARS)}...[clamped]` }
    line = JSON.stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  if (wire.data !== undefined) {
    wire.data = { truncated: true, originalBytes: bytes(JSON.stringify(wire.data)) }
    line = JSON.stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  // Nothing structured is left to shed, so the message itself is oversized. Clamp it and accept
  // the loss: a record on disk beats a record silently dropped.
  wire.msg = wire.msg.slice(0, 500)
  wire.err = wire.err ? { name: wire.err.name, message: wire.err.message.slice(0, 500) } : undefined
  return JSON.stringify(wire).slice(0, MAX_RECORD_BYTES)
}
