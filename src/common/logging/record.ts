/**
 * The shape of one log line and the pure transformations every producer shares: level
 * comparison, error normalisation, secret redaction, and serialisation to a single JSON line.
 *
 * Redaction lives here rather than at the call sites so that no producer can forget it, and
 * serialisation is the only place a record's size is bounded.
 *
 * Nothing here may throw into its caller. A diagnostic call that fails takes down the operation it
 * was meant to explain, so every value a record carries is treated as untrusted: it may be cyclic,
 * unreadable, unserialisable, or arbitrarily large, and it still has to end as one bounded line.
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

/**
 * A scheme-qualified URL wherever it appears in free text. Credentials reach the log inside
 * sentences far more often than on their own: an HTTP client quotes the failing request in its
 * error message, so the URL arrives surrounded by prose.
 */
const EMBEDDED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

const MAX_STACK_CHARS = 2000

const MAX_CAUSE_DEPTH = 5

/**
 * Text allowances tried in turn once a record is oversized because a single field is. JSON escaping
 * can expand one character sixfold, so no fixed byte allowance bounds the line on its own; the last
 * entry leaves nothing but the markers and therefore always fits.
 */
const FIELD_BUDGETS = [500, 100, 20, 0]

const CIRCULAR = '[circular]'

const UNREADABLE = '[unreadable]'

export function isLevelEnabled(level: LogLevel, floor: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[floor]
}

/** Describe a value that refuses to be read, rather than letting its failure escape. */
function safeText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return `[unprintable ${typeof value}]`
  }
}

/**
 * Reduce anything throwable to a serialisable shape. Non-errors are described rather than
 * discarded, because a rejected promise carrying a string is exactly the case worth seeing.
 */
export function normalizeError(err: unknown): NormalizedError {
  try {
    return walkError(err, 0)
  } catch {
    return { name: 'UnreadableError', message: UNREADABLE }
  }
}

function walkError(err: unknown, depth: number): NormalizedError {
  if (!(err instanceof Error)) {
    return { name: typeof err, message: err === null ? 'null' : safeText(err) }
  }
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  const cause = (err as Error & { cause?: unknown }).cause
  // A cause that points back into the chain would recurse forever; depth is the cheap guard.
  if (cause !== undefined && cause !== err && depth < MAX_CAUSE_DEPTH) {
    out.cause = walkError(cause, depth + 1)
  }
  return out
}

/**
 * Deep copy with every secret removed: a key whose name suggests a credential is replaced outright,
 * and any URL among the values has its credential-bearing parameters stripped.
 *
 * Cycles, unreadable properties and exotic objects all resolve to a marker rather than throwing, so
 * a logging call can never fail because of the shape of what it was given.
 */
export function redactValue(value: unknown): unknown {
  return redactAny(value, new WeakSet<object>())
}

function redactAny(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'function') return '[function]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  try {
    return redactObject(value, seen)
  } finally {
    // Released on the way back out, so the same object referenced twice in one tree is reported
    // in full both times instead of being mistaken for a cycle.
    seen.delete(value)
  }
}

/**
 * Copy an object, keeping the meaning of the built-in types a caller is most likely to log.
 *
 * Enumerating own properties is what a plain object needs and what a Date, Error, Map or Set cannot
 * survive: they carry their content internally and would each flatten to `{}`, silently destroying
 * the value the record exists to report.
 */
function redactObject(value: object, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAny(item, seen))
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (value instanceof Error) return redactError(normalizeError(value))
  if (value instanceof Set) return [...value].map((item) => redactAny(item, seen))
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of value) {
      const name = safeText(key)
      out[name] = SECRET_KEY.test(name) ? REDACTED : redactAny(item, seen)
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const key of ownKeys(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : readAndRedact(value, key, seen)
  }
  return out
}

function ownKeys(value: object): string[] {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

/**
 * Read one property and redact it. Reading is where a hostile or lazy object bites: a getter runs
 * arbitrary code, so its failure is contained here and costs one property rather than the record.
 */
function readAndRedact(owner: object, key: string, seen: WeakSet<object>): unknown {
  try {
    return redactAny((owner as Record<string, unknown>)[key], seen)
  } catch {
    return UNREADABLE
  }
}

/**
 * Strip credentials from every URL a piece of text contains. Safe on arbitrary text: anything that
 * is not a URL is returned untouched.
 */
function redactText(value: string): string {
  if (!value.includes('://')) return value
  return value.replace(EMBEDDED_URL, (match) => redactUrl(match))
}

/** Redact an error and its causes, since a client's message and stack routinely quote the request. */
function redactError(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: redactText(err.message) }
  if (err.stack) out.stack = redactText(err.stack)
  if (err.cause) out.cause = redactError(err.cause)
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
  // Only the marker itself is un-escaped, so the result stays a URL a reader can paste back.
  // Decoding the whole string instead would rewrite every other escape and would throw outright
  // on a malformed one, turning a diagnostic call into the failure being diagnosed.
  return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED)
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

/**
 * The fields that identify an event, kept as free strings because a degraded line is built from
 * whatever the record actually held rather than from what its type promised.
 */
interface DegradedRecord {
  ts: string
  level: string
  proc: string
  pid: number
  scope: string
  msg: string
  data: { truncated: true }
  err?: { name: string; message: string }
}

function toWire(record: LogRecord): WireRecord {
  const wire: WireRecord = {
    ts: record.ts,
    level: record.level,
    proc: record.proc,
    pid: record.pid,
    scope: record.scope,
    msg: redactText(record.msg)
  }
  if (record.data !== undefined) wire.data = redactValue(record.data)
  if (record.err !== undefined) wire.err = redactError(record.err)
  return wire
}

const UTF8 = new TextEncoder()

/**
 * The UTF-8 length of a line, measured with a platform global rather than Node's `Buffer`, because
 * the sandboxed renderer serialises its own records and has no Node globals to reach for.
 */
function bytes(line: string): number {
  return UTF8.encode(line).length
}

/**
 * Render as JSON, describing a `bigint` rather than failing on it. `JSON.stringify` throws on one,
 * and an identifier that happens to be a `bigint` must not cost the whole record.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))
}

function clampChars(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[clamped]`
}

/** Read a field that the types call a string but an untrusted producer may have sent as anything. */
function field(value: unknown, budget: number): string {
  return clampChars(typeof value === 'string' ? redactText(value) : '', budget)
}

function clampStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = clampChars(err.stack, MAX_STACK_CHARS)
  if (err.cause) out.cause = clampStacks(err.cause)
  return out
}

/**
 * Keep the reported failure's own frames but drop those of its causes. Messages are the cheaper
 * half of an error by far, so the whole chain still says what happened even once the frames go.
 */
function withoutCauseStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  if (err.cause) out.cause = dropStacks(err.cause)
  return out
}

function dropStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.cause) out.cause = dropStacks(err.cause)
  return out
}

function withCauseLimit(err: NormalizedError, limit: number): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  if (err.cause && limit > 0) out.cause = withCauseLimit(err.cause, limit - 1)
  return out
}

function causeDepth(err: NormalizedError): number {
  let depth = 0
  for (let node = err.cause; node; node = node.cause) depth += 1
  return depth
}

/**
 * The fallback line: the fields that identify the event, and a marker saying the rest was shed.
 * Built only from primitives read defensively, so it cannot fail the way the full record did.
 */
function degrade(
  record: LogRecord,
  err: NormalizedError | undefined,
  budget: number
): DegradedRecord {
  const out: DegradedRecord = {
    ts: field(record.ts, budget),
    level: field(record.level, budget),
    proc: field(record.proc, budget),
    pid: Number.isFinite(record.pid) ? record.pid : 0,
    scope: field(record.scope, budget),
    msg: field(record.msg, budget),
    data: { truncated: true }
  }
  if (err) out.err = { name: field(err.name, budget), message: field(err.message, budget) }
  return out
}

/**
 * Render one record as a single JSON line, redacted and size-bounded.
 *
 * An oversized record is shrunk in stages rather than dropped, shedding what costs least to lose
 * first: over-long stacks, then the structured payload, then the frames of the wrapping errors,
 * then the wrappers themselves, and only last the identifying fields. Wrapping an error must never
 * make it log less than the bare error would have. Staying well inside the atomic-append limit is
 * what keeps three processes writing one file from interleaving a partial line.
 */
export function serialize(record: LogRecord): string {
  try {
    return bound(record)
  } catch {
    // A value the record carried could not be read or rendered. The event still gets a line: this
    // one is assembled from primitives alone, so it cannot fail the same way.
    return stringify(degrade(record, undefined, FIELD_BUDGETS[0]))
  }
}

function bound(record: LogRecord): string {
  const wire = toWire(record)
  let line = stringify(wire)
  if (bytes(line) <= MAX_RECORD_BYTES) return line

  if (wire.err) {
    wire.err = clampStacks(wire.err)
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  if (wire.data !== undefined) {
    wire.data = { truncated: true, originalBytes: bytes(stringify(wire.data)) }
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  if (wire.err?.cause) {
    let err = withoutCauseStacks(wire.err)
    wire.err = err
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line

    // Still oversized on messages alone. Shed the causes furthest from the reported failure first.
    for (let limit = causeDepth(err) - 1; limit >= 0; limit--) {
      err = withCauseLimit(err, limit)
      wire.err = err
      line = stringify(wire)
      if (bytes(line) <= MAX_RECORD_BYTES) return line
    }
  }

  // Only the identifying fields are left, so one of them is itself oversized.
  for (const budget of FIELD_BUDGETS) {
    line = stringify(degrade(record, wire.err, budget))
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }
  return line
}
