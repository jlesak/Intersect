# Structured Logging Infrastructure (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Intersect a durable, field-oriented JSONL log covering all three processes, every RPC call, every outbound HTTP and MCP request, and every uncaught error - so a crash can be diagnosed after the fact.

**Architecture:** A pure record/level/redaction core in `src/common/logging` with I/O injected as a `LogSink`. Main and core each open the same daily file `O_APPEND` and append directly, so a dying core's last records reach disk with no transport in the path. The sandboxed renderer has no filesystem access, so it ships records to main over a plain (non-`Channel`) IPC channel and main appends them.

**Tech Stack:** TypeScript 5.9, Electron 43 (`utilityProcess`), Vitest 4 (`node` + `dom` projects), Playwright `_electron`, ESLint 9 flat config.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-structured-logging-design.md`. Read it before Task 1.
- Log file: `<userData>/logs/intersect-YYYY-MM-DD.jsonl`, one JSON object per line. Retention 7 days.
- `MAX_RECORD_BYTES = 8192`. Records exceeding it are shrunk deterministically, never dropped.
- Level floor from `INTERSECT_LOG_LEVEL`; default `debug` in development, `info` when packaged.
- Redaction key pattern, used verbatim: `/pat|token|cookie|password|secret|authorization|bearer|apikey/i`
- PTY output is never logged as content anywhere - byte counts only.
- Logging must never throw into a caller and never change control flow.
- No new runtime dependencies.
- `src/core` may not import `electron` (ESLint-enforced). `src/common/logging/fileSink.node.ts` must never be imported by renderer or preload.
- Comment style per `~/.claude/CLAUDE.md`: multi-line doc comments on non-trivial members, describing business meaning; no references to PRs, issues, or tasks in code comments. Never use the em dash character.
- Every task ends green on `npm run lint`, `npm run typecheck`, `npm test`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/common/logging/record.ts` | Types, level ordering, `normalizeError`, `redactValue`, `redactUrl`, `summarizeArgs`, `serialize`. Pure, no I/O |
| `src/common/logging/logger.ts` | `createLogger`, `child(scope)`, level filtering, rate guard. All I/O injected |
| `src/common/logging/channel.ts` | `RENDERER_LOG_CHANNEL`, `UNLOGGED_CHANNELS`. No Node imports, safe for the renderer bundle |
| `src/common/logging/fileSink.node.ts` | `O_APPEND` sink, daily filename, retention prune. Node-only |
| `src/common/logging/httpLogging.ts` | `withHttpLogging` decorator |
| `src/core/logging/index.ts` | Core's logger instance and global handlers |
| `src/main/logging/index.ts` | Main's logger, global handlers, renderer-record receiver, startup prune |
| `src/renderer/src/shared/logging/logger.ts` | Renderer logger over the IPC sink, global handlers, console mirroring |

Modified: `src/common/portRpc.ts`, `src/common/ipc.ts`, `src/preload/index.ts`, `src/core/index.ts`, `src/core/bootstrap.ts`, `src/core/prInbox/adoClient.ts`, `src/core/prInbox/adoVote.ts`, `src/core/settings/adoTestConnection.ts`, `src/main/index.ts`, `src/main/coreHost.ts`, `src/main/ipc/bridge.ts`, `eslint.config.js`, `package.json`.

---

### Task 1: The log record

**Files:**
- Create: `src/common/logging/record.ts`
- Test: `src/common/logging/record.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LogLevel`, `LogScope`, `LogProc`, `LogRecord`, `NormalizedError`, `LEVEL_ORDER`, `isLevelEnabled(level: LogLevel, floor: LogLevel): boolean`, `normalizeError(err: unknown): NormalizedError`, `redactValue(value: unknown): unknown`, `redactUrl(raw: string): string`, `summarizeArgs(args: unknown[]): string[]`, `serialize(record: LogRecord): string`, `MAX_RECORD_BYTES`, `REDACTED`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/logging/record.test.ts
import { describe, expect, it } from 'vitest'
import {
  isLevelEnabled,
  MAX_RECORD_BYTES,
  normalizeError,
  redactUrl,
  redactValue,
  REDACTED,
  serialize,
  summarizeArgs,
  type LogRecord
} from './record'

const base: LogRecord = {
  ts: '2026-07-28T09:14:02.417Z',
  level: 'info',
  proc: 'core',
  pid: 4821,
  scope: 'jira',
  msg: 'board fetched'
}

describe('isLevelEnabled', () => {
  it('admits levels at or above the floor', () => {
    expect(isLevelEnabled('error', 'info')).toBe(true)
    expect(isLevelEnabled('info', 'info')).toBe(true)
    expect(isLevelEnabled('debug', 'info')).toBe(false)
  })
})

describe('normalizeError', () => {
  it('keeps name, message and stack', () => {
    const err = new TypeError('bad shape')
    const out = normalizeError(err)
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('bad shape')
    expect(out.stack).toContain('bad shape')
  })

  it('walks the cause chain', () => {
    const out = normalizeError(new Error('outer', { cause: new Error('inner') }))
    expect(out.cause?.message).toBe('inner')
  })

  it('stops a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown }
    err.cause = err
    expect(() => normalizeError(err)).not.toThrow()
  })

  it('describes non-errors without throwing', () => {
    expect(normalizeError('plain string').message).toBe('plain string')
    expect(normalizeError(null).message).toBe('null')
  })
})

describe('redactValue', () => {
  it('redacts secret-bearing keys at any depth', () => {
    const out = redactValue({ ado: { pat: 'abc' }, list: [{ Authorization: 'Bearer x' }] }) as {
      ado: { pat: string }
      list: Array<{ Authorization: string }>
    }
    expect(out.ado.pat).toBe(REDACTED)
    expect(out.list[0].Authorization).toBe(REDACTED)
  })

  it('leaves innocent keys alone', () => {
    expect(redactValue({ status: 503 })).toEqual({ status: 503 })
  })

  it('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    expect(() => redactValue(cyclic)).not.toThrow()
  })
})

describe('redactUrl', () => {
  it('keeps origin and path', () => {
    expect(redactUrl('https://jira.example.com/rest/api/2/search?jql=x')).toBe(
      'https://jira.example.com/rest/api/2/search?jql=x'
    )
  })

  it('strips only the secret-bearing parameters', () => {
    expect(redactUrl('https://h.example/a?api-version=7.1&access_token=secret')).toBe(
      `https://h.example/a?api-version=7.1&access_token=${REDACTED}`
    )
  })

  it('returns a non-URL unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url')
  })
})

describe('summarizeArgs', () => {
  it('reports shapes and lengths, never values', () => {
    expect(summarizeArgs(['abc', [1, 2], null, 7, { a: 1 }])).toEqual([
      'string(3)',
      'array(2)',
      'null',
      'number',
      'object'
    ])
  })
})

describe('serialize', () => {
  it('emits exactly one line of valid JSON', () => {
    const line = serialize(base)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({ scope: 'jira', msg: 'board fetched' })
  })

  it('omits absent optional fields', () => {
    expect(Object.keys(JSON.parse(serialize(base)))).not.toContain('data')
  })

  it('redacts data on the way out', () => {
    const line = serialize({ ...base, data: { token: 'sensitive' } })
    expect(line).not.toContain('sensitive')
  })

  it('shrinks an oversized record instead of dropping it', () => {
    const line = serialize({ ...base, data: { blob: 'x'.repeat(MAX_RECORD_BYTES * 2) } })
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    const parsed = JSON.parse(line)
    expect(parsed.msg).toBe('board fetched')
    expect(parsed.data.truncated).toBe(true)
  })

  it('keeps the message and error when the stack alone is enormous', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n' + '    at frame\n'.repeat(2000)
    const parsed = JSON.parse(serialize({ ...base, level: 'error', err: normalizeError(err) }))
    expect(parsed.err.message).toBe('boom')
    expect(parsed.err.stack.length).toBeLessThan(3000)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/logging/record.test.ts`
Expected: FAIL - cannot resolve `./record`.

- [ ] **Step 3: Implement `record.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/logging/record.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/logging/record.ts src/common/logging/record.test.ts
git commit -m "feat(logging): the log record, redaction and serialisation"
```

---

### Task 2: The logger factory

**Files:**
- Create: `src/common/logging/logger.ts`
- Test: `src/common/logging/logger.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `LogSink` (`{ write(line: string): void }`), `LogFields` (`{ data?: Record<string, unknown>; err?: unknown }`), `Logger` (`{ error, warn, info, debug (msg: string, fields?: LogFields) => void; child(scope: LogScope): Logger }`), `LoggerOptions`, `createLogger(opts: LoggerOptions): Logger`, `parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel`, `DEFAULT_MAX_RECORDS_PER_SECOND`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/logging/logger.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createLogger, parseLevel, type LogSink } from './logger'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function parsed(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createLogger', () => {
  it('writes a record carrying process identity and scope', () => {
    const sink = fakeSink()
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      pid: 42,
      scope: 'jira',
      now: () => new Date('2026-07-28T09:00:00.000Z')
    })
    log.info('board fetched', { data: { issues: 12 } })
    expect(parsed(sink)[0]).toMatchObject({
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      proc: 'core',
      pid: 42,
      scope: 'jira',
      msg: 'board fetched',
      data: { issues: 12 }
    })
  })

  it('drops records below the floor', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'info', proc: 'main' })
    log.debug('noise')
    log.warn('kept')
    expect(parsed(sink).map((r) => r.level)).toEqual(['warn'])
  })

  it('normalises a thrown value passed as err', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'debug', proc: 'main' })
    log.error('failed', { err: new Error('boom') })
    expect(parsed(sink)[0].err).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('child inherits configuration and overrides only the scope', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'debug', proc: 'core', scope: 'lifecycle' })
    log.child('rpc').debug('served')
    expect(parsed(sink)[0]).toMatchObject({ scope: 'rpc', proc: 'core' })
  })

  it('never lets a failing sink reach the caller', () => {
    const onSinkFailure = vi.fn()
    const log = createLogger({
      sink: {
        write: () => {
          throw new Error('disk gone')
        }
      },
      level: 'debug',
      proc: 'main',
      onSinkFailure
    })
    expect(() => log.error('anything')).not.toThrow()
    expect(onSinkFailure).toHaveBeenCalledTimes(1)
  })

  it('stops writing after the sink has failed once', () => {
    let calls = 0
    const log = createLogger({
      sink: {
        write: () => {
          calls += 1
          throw new Error('disk gone')
        }
      },
      level: 'debug',
      proc: 'main',
      onSinkFailure: () => {}
    })
    log.error('one')
    log.error('two')
    expect(calls).toBe(1)
  })

  it('caps the rate and reports what it dropped', () => {
    const sink = fakeSink()
    let ms = 0
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      maxRecordsPerSecond: 2,
      now: () => new Date(ms)
    })
    log.info('a')
    log.info('b')
    log.info('c')
    log.info('d')
    expect(sink.lines).toHaveLength(2)

    ms = 1500
    log.info('next window')
    const summary = parsed(sink).find((r) => r.scope === 'log')
    expect(summary).toMatchObject({ level: 'warn', data: { dropped: 2 } })
  })

  it('shares one rate budget with its children', () => {
    const sink = fakeSink()
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      maxRecordsPerSecond: 1,
      now: () => new Date(0)
    })
    log.info('parent')
    log.child('rpc').info('child')
    expect(sink.lines).toHaveLength(1)
  })
})

describe('parseLevel', () => {
  it('accepts a known level', () => {
    expect(parseLevel('warn', 'info')).toBe('warn')
  })

  it('falls back on anything unrecognised', () => {
    expect(parseLevel('verbose', 'info')).toBe('info')
    expect(parseLevel(undefined, 'debug')).toBe('debug')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/logging/logger.test.ts`
Expected: FAIL - cannot resolve `./logger`.

- [ ] **Step 3: Implement `logger.ts`**

```ts
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

export function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  return raw !== undefined && raw in LEVEL_ORDER ? (raw as LogLevel) : fallback
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/logging/logger.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/logging/logger.ts src/common/logging/logger.test.ts
git commit -m "feat(logging): logger factory with level floor and rate guard"
```

---

### Task 3: The file sink

**Files:**
- Create: `src/common/logging/fileSink.node.ts`
- Test: `src/common/logging/fileSink.node.test.ts`

**Interfaces:**
- Consumes: `LogSink` from Task 2.
- Produces: `dailyLogFileName(now: Date): string`, `pruneOldLogs(dir: string, now: Date, retentionDays: number): string[]`, `createFileSink(opts: FileSinkOptions): FileSink` where `FileSink = LogSink & { close(): void }`, `LOG_DIR_NAME`, `DEFAULT_RETENTION_DAYS`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/logging/fileSink.node.test.ts
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileSink, dailyLogFileName, pruneOldLogs } from './fileSink.node'

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intersect-logsink-'))
  dirs.push(dir)
  return dir
}

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/logging/fileSink.node.test.ts`
Expected: FAIL - cannot resolve `./fileSink.node`.

- [ ] **Step 3: Implement `fileSink.node.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/logging/fileSink.node.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/logging/fileSink.node.ts src/common/logging/fileSink.node.test.ts
git commit -m "feat(logging): append-only daily file sink with retention"
```

---

### Task 4: The log channel constant and unlogged-channel set

**Files:**
- Create: `src/common/logging/channel.ts`
- Test: `src/common/logging/channel.test.ts`

**Interfaces:**
- Consumes: `Channel` from `@common/ipc`.
- Produces: `RENDERER_LOG_CHANNEL` (`'log:write'`), `UNLOGGED_CHANNELS: ReadonlySet<string>`.

This file must import nothing from Node, because the renderer and preload both load it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/logging/channel.test.ts
import { describe, expect, it } from 'vitest'
import { Channel } from '../ipc'
import { RENDERER_LOG_CHANNEL, UNLOGGED_CHANNELS } from './channel'

describe('RENDERER_LOG_CHANNEL', () => {
  it('is not a member of the routed channel taxonomy', () => {
    // CORE_INVOKE_CHANNELS is derived as "every Channel not otherwise classified", so a log
    // channel added to the enum would silently be forwarded into the core process.
    expect(Object.values(Channel)).not.toContain(RENDERER_LOG_CHANNEL)
  })
})

describe('UNLOGGED_CHANNELS', () => {
  it('excludes the high-frequency terminal paths', () => {
    expect(UNLOGGED_CHANNELS.has(Channel.terminalInput)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalResize)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalData)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.prInboxReviewData)).toBe(true)
  })

  it('still logs low-frequency terminal lifecycle', () => {
    expect(UNLOGGED_CHANNELS.has(Channel.terminalSpawn)).toBe(false)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalKill)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/logging/channel.test.ts`
Expected: FAIL - cannot resolve `./channel`.

- [ ] **Step 3: Implement `channel.ts`**

```ts
import { Channel } from '../ipc'

/**
 * The renderer's route to the log file. Deliberately a plain constant rather than a `Channel`
 * member: `CORE_INVOKE_CHANNELS` is derived as every channel not otherwise classified, so adding
 * this to the enum would register a forwarder shipping log records into the core process and turn
 * a fire-and-forget send into a round trip. `NATIVE_NOTIFICATION_PUSH` and `CORE_SHUTDOWN_CHANNEL`
 * sit outside the enum for the same reason.
 */
export const RENDERER_LOG_CHANNEL = 'log:write'

/**
 * Channels whose traffic is never logged. These carry terminal keystrokes and terminal output at
 * keyboard and screen-refresh rates; recording them would flood the file and throttle the very
 * terminal being logged. Terminal lifecycle - spawn, kill, exit - stays logged, because it is
 * low-frequency and diagnostically valuable.
 */
export const UNLOGGED_CHANNELS: ReadonlySet<string> = new Set<string>([
  Channel.terminalInput,
  Channel.terminalResize,
  Channel.terminalPause,
  Channel.terminalResume,
  Channel.terminalData,
  Channel.prInboxReviewInput,
  Channel.prInboxReviewResize,
  Channel.prInboxReviewData
])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/logging/channel.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/logging/channel.ts src/common/logging/channel.test.ts
git commit -m "feat(logging): renderer log channel kept outside the routed taxonomy"
```

---

### Task 5: RPC instrumentation

**Files:**
- Modify: `src/common/portRpc.ts`
- Test: `src/common/portRpc.logging.test.ts`

**Interfaces:**
- Consumes: `Logger` from Task 2, `UNLOGGED_CHANNELS` from Task 4.
- Produces: `PortRpcOptions` (`{ logger?: Logger; unloggedChannels?: ReadonlySet<string> }`) and a second, optional `PortRpc` constructor parameter. Existing `new PortRpc(port)` call sites keep working unchanged.

Instrumenting the class rather than wrapping it means one change covers both ends of the bridge.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/portRpc.logging.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogSink } from './logging/logger'
import { UNLOGGED_CHANNELS } from './logging/channel'
import { PortRpc, type RpcPort } from './portRpc'

/** A pair of ports wired straight to each other, so a request really round-trips. */
function portPair(): [RpcPort, RpcPort] {
  const handlers: Array<Array<(msg: { data: unknown }) => void>> = [[], []]
  const make = (self: 0 | 1): RpcPort => ({
    postMessage: (data) => {
      for (const h of handlers[self === 0 ? 1 : 0]) h({ data })
    },
    on: (_event, handler) => void handlers[self].push(handler)
  })
  return [make(0), make(1)]
}

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function records(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('PortRpc logging', () => {
  it('logs a served request at debug with its channel and duration', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => 'ok')
    await caller.invoke('workspaces:getState', [])
    const served = records(sink).find((r) => r.msg === 'rpc served')
    expect(served).toMatchObject({ level: 'debug', scope: 'rpc' })
    expect((served?.data as { channel: string }).channel).toBe('workspaces:getState')
    expect((served?.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs a rejected request at error with the stack', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => {
      throw new Error('handler blew up')
    })
    await expect(caller.invoke('todo:list', [])).rejects.toThrow('handler blew up')
    const failed = records(sink).find((r) => r.msg === 'rpc failed')
    expect(failed).toMatchObject({ level: 'error' })
    expect((failed?.err as { message: string }).message).toBe('handler blew up')
    expect((failed?.err as { stack?: string }).stack).toBeDefined()
  })

  it('summarises arguments by shape, never by value', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' })
    })
    server.onRequest(async () => null)
    await caller.invoke('todo:add', ['buy milk', null])
    const served = records(sink).find((r) => r.msg === 'rpc served')
    expect((served?.data as { args: string[] }).args).toEqual(['string(8)', 'null'])
    expect(sink.lines.join()).not.toContain('buy milk')
  })

  it('writes nothing for an unlogged terminal channel', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' }),
      unloggedChannels: UNLOGGED_CHANNELS
    })
    server.onRequest(async () => undefined)
    caller.notify('terminal:input', ['s1', 'ls -la\r'])
    await Promise.resolve()
    expect(sink.lines).toEqual([])
  })

  it('logs a failing notification, which has nowhere else to surface', async () => {
    const sink = fakeSink()
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b, {
      logger: createLogger({ sink, level: 'debug', proc: 'core', scope: 'rpc' }),
      unloggedChannels: UNLOGGED_CHANNELS
    })
    server.onRequest(async () => {
      throw new Error('notify failed')
    })
    caller.notify('terminal:kill', ['s1'])
    await vi.waitFor(() => expect(records(sink).some((r) => r.level === 'error')).toBe(true))
  })

  it('works exactly as before with no logger supplied', async () => {
    const [a, b] = portPair()
    const caller = new PortRpc(a)
    const server = new PortRpc(b)
    server.onRequest(async () => 'fine')
    await expect(caller.invoke('todo:list', [])).resolves.toBe('fine')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/portRpc.logging.test.ts`
Expected: FAIL - `PortRpc` takes one argument.

- [ ] **Step 3: Add the options parameter and instrumentation**

In `src/common/portRpc.ts`, add the imports and the options interface above the class:

```ts
import { UNLOGGED_CHANNELS } from './logging/channel'
import type { Logger } from './logging/logger'
import { summarizeArgs } from './logging/record'

/**
 * Optional observability for one end of the bridge. Instrumenting the transport rather than each
 * call site means a single seam records everything the renderer asked for and everything the core
 * answered.
 */
export interface PortRpcOptions {
  logger?: Logger
  /** Channels whose traffic is too high-frequency to record; defaults to the terminal fast path. */
  unloggedChannels?: ReadonlySet<string>
}
```

Change the constructor:

```ts
  private readonly logger: Logger | null
  private readonly unlogged: ReadonlySet<string>

  constructor(
    private port: RpcPort,
    options: PortRpcOptions = {}
  ) {
    this.logger = options.logger ?? null
    this.unlogged = options.unloggedChannels ?? UNLOGGED_CHANNELS
    port.on('message', (msg) => this.handle(msg.data))
    port.start?.()
  }
```

In `handle`, replace the notification branch:

```ts
      if (typeof msg.id !== 'string') {
        // Notification: run the handler, but failures have nowhere to go except the log.
        try {
          await handler?.(msg.channel, args)
        } catch (err) {
          this.logger?.error('rpc notification failed', {
            data: { channel: msg.channel, args: summarizeArgs(args) },
            err
          })
        }
        return
      }
```

And replace the request branch:

```ts
      const startedAt = Date.now()
      const loggable = this.logger !== null && !this.unlogged.has(msg.channel)
      let response: WireResponse
      try {
        if (!handler) throw new Error(`no request handler for ${msg.channel}`)
        response = { id: msg.id, ok: true, value: await handler(msg.channel, args), response: true }
        if (loggable) {
          this.logger?.debug('rpc served', {
            data: {
              channel: msg.channel,
              args: summarizeArgs(args),
              durationMs: Date.now() - startedAt
            }
          })
        }
      } catch (err) {
        if (loggable) {
          this.logger?.error('rpc failed', {
            data: {
              channel: msg.channel,
              args: summarizeArgs(args),
              durationMs: Date.now() - startedAt
            },
            err
          })
        }
        // A throwing handler must still answer, otherwise the caller's invoke hangs forever.
        response = {
          id: msg.id,
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
          response: true
        }
      }
```

Also replace the existing `console.error` in the push branch with `this.logger?.error('rpc push subscriber threw', { data: { channel: msg.push }, err })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/portRpc.logging.test.ts src/common/portRpc.test.ts`
Expected: PASS. The pre-existing `portRpc.test.ts` must stay green - the options parameter is optional.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/portRpc.ts src/common/portRpc.logging.test.ts
git commit -m "feat(logging): record RPC traffic at the transport seam"
```

---

### Task 6: HTTP instrumentation

**Files:**
- Create: `src/common/logging/httpLogging.ts`
- Test: `src/common/logging/httpLogging.test.ts`

**Interfaces:**
- Consumes: `Logger` from Task 2, `redactUrl` from Task 1.
- Produces: `withHttpLogging(fetchFn: typeof fetch, logger: Logger): typeof fetch`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/logging/httpLogging.test.ts
import { describe, expect, it } from 'vitest'
import { withHttpLogging } from './httpLogging'
import { createLogger, type LogSink } from './logger'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function records(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

function logger(sink: LogSink) {
  return createLogger({ sink, level: 'debug', proc: 'core', scope: 'http' })
}

describe('withHttpLogging', () => {
  it('logs a successful request at debug', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}', { status: 200 }), logger(sink))
    await wrapped('https://jira.example.com/rest/api/2/search')
    expect(records(sink)[0]).toMatchObject({
      level: 'debug',
      scope: 'http',
      msg: 'http request',
      data: { method: 'GET', status: 200, url: 'https://jira.example.com/rest/api/2/search' }
    })
  })

  it('logs a 4xx or 5xx response at error', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('nope', { status: 503 }), logger(sink))
    await wrapped('https://h.example/a')
    expect(records(sink)[0]).toMatchObject({ level: 'error', data: { status: 503 } })
  })

  it('logs a transport failure and rethrows it', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => {
      throw new Error('ECONNREFUSED')
    }, logger(sink))
    await expect(wrapped('https://h.example/a')).rejects.toThrow('ECONNREFUSED')
    expect(records(sink)[0]).toMatchObject({ level: 'error', msg: 'http request failed' })
  })

  it('reports the method from the request init', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}'), logger(sink))
    await wrapped('https://h.example/a', { method: 'POST' })
    expect((records(sink)[0].data as { method: string }).method).toBe('POST')
  })

  it('never puts a credential from the query string in the log', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}'), logger(sink))
    await wrapped('https://h.example/a?access_token=supersecret')
    expect(sink.lines.join()).not.toContain('supersecret')
  })

  it('returns the original response untouched', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('body', { status: 201 }), logger(sink))
    const res = await wrapped('https://h.example/a')
    expect(res.status).toBe(201)
    await expect(res.text()).resolves.toBe('body')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/common/logging/httpLogging.test.ts`
Expected: FAIL - cannot resolve `./httpLogging`.

- [ ] **Step 3: Implement `httpLogging.ts`**

```ts
import type { Logger } from './logger'
import { redactUrl } from './record'

/**
 * Wrap a `fetch` so every outbound call is recorded with its method, redacted URL, status and
 * duration. Applied where `fetch` is injected, so no call site changes and nothing can bypass it.
 *
 * The response is returned untouched: the body is never read here, which would consume the stream
 * the caller is about to use.
 */
export function withHttpLogging(fetchFn: typeof fetch, logger: Logger): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const rawUrl = input instanceof Request ? input.url : String(input)
    const url = redactUrl(rawUrl)
    const startedAt = Date.now()
    try {
      const response = await fetchFn(input, init)
      const data = { method, url, status: response.status, durationMs: Date.now() - startedAt }
      if (response.ok) logger.debug('http request', { data })
      else logger.error('http request', { data })
      return response
    } catch (err) {
      logger.error('http request failed', {
        data: { method, url, durationMs: Date.now() - startedAt },
        err
      })
      throw err
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/common/logging/httpLogging.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/logging/httpLogging.ts src/common/logging/httpLogging.test.ts
git commit -m "feat(logging): fetch decorator recording outbound HTTP"
```

---

### Task 7: The core process logger

**Files:**
- Create: `src/core/logging/index.ts`
- Test: `src/core/logging/index.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `createCoreLogger(opts: { userDataDir: string; env: NodeJS.ProcessEnv; sink?: LogSink; now?: () => Date }): Logger`, `installCoreGlobalHandlers(logger: Logger, onFatal?: () => void): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/logging/index.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { LogSink } from '@common/logging/logger'
import { createCoreLogger, installCoreGlobalHandlers } from './index'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function records(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createCoreLogger', () => {
  it('stamps every record as the core process', () => {
    const sink = fakeSink()
    createCoreLogger({ userDataDir: '/tmp/x', env: {}, sink }).info('up')
    expect(records(sink)[0]).toMatchObject({ proc: 'core' })
  })

  it('honours INTERSECT_LOG_LEVEL', () => {
    const sink = fakeSink()
    const log = createCoreLogger({
      userDataDir: '/tmp/x',
      env: { INTERSECT_LOG_LEVEL: 'error' },
      sink
    })
    log.warn('suppressed')
    log.error('kept')
    expect(records(sink).map((r) => r.level)).toEqual(['error'])
  })

  it('defaults to info when packaged and debug otherwise', () => {
    const packaged = fakeSink()
    createCoreLogger({ userDataDir: '/tmp/x', env: { NODE_ENV: 'production' }, sink: packaged }).debug('x')
    expect(packaged.lines).toEqual([])

    const dev = fakeSink()
    createCoreLogger({ userDataDir: '/tmp/x', env: {}, sink: dev }).debug('x')
    expect(dev.lines).toHaveLength(1)
  })
})

describe('installCoreGlobalHandlers', () => {
  it('records an uncaught exception and then calls onFatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    const log = createCoreLogger({ userDataDir: '/tmp/x', env: {}, sink })
    const before = process.listenerCount('uncaughtException')
    installCoreGlobalHandlers(log, onFatal)
    process.emit('uncaughtException', new Error('kaboom'))
    const rec = records(sink).find((r) => r.msg === 'uncaught exception')
    expect(rec).toMatchObject({ level: 'error' })
    expect((rec?.err as { message: string }).message).toBe('kaboom')
    expect(onFatal).toHaveBeenCalledTimes(1)
    process.removeAllListeners('uncaughtException')
    expect(before).toBeGreaterThanOrEqual(0)
  })

  it('records an unhandled rejection without treating it as fatal', () => {
    const sink = fakeSink()
    const onFatal = vi.fn()
    installCoreGlobalHandlers(createCoreLogger({ userDataDir: '/tmp/x', env: {}, sink }), onFatal)
    process.emit('unhandledRejection', new Error('dangling'), Promise.resolve())
    expect(records(sink).some((r) => r.msg === 'unhandled rejection')).toBe(true)
    expect(onFatal).not.toHaveBeenCalled()
    process.removeAllListeners('unhandledRejection')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/logging/index.test.ts`
Expected: FAIL - cannot resolve `./index`.

- [ ] **Step 3: Implement `src/core/logging/index.ts`**

```ts
import { join } from 'node:path'
import { createFileSink, LOG_DIR_NAME } from '@common/logging/fileSink.node'
import { createLogger, parseLevel, type Logger, type LogSink } from '@common/logging/logger'
import type { LogLevel } from '@common/logging/record'

/**
 * The core process's diagnostic surface. The core owns the database, the PTYs and every outbound
 * request, so most of what is worth knowing about a run originates here - and because it is also
 * the process most likely to die, it writes to the log file directly rather than through the port.
 */

export interface CoreLoggerOptions {
  userDataDir: string
  env: NodeJS.ProcessEnv
  /** Injected in tests; production opens the shared daily file. */
  sink?: LogSink
  now?: () => Date
}

function defaultLevel(env: NodeJS.ProcessEnv): LogLevel {
  return env.NODE_ENV === 'production' ? 'info' : 'debug'
}

export function createCoreLogger(opts: CoreLoggerOptions): Logger {
  const sink =
    opts.sink ??
    createFileSink({
      dir: join(opts.userDataDir, LOG_DIR_NAME),
      now: opts.now,
      // The log file is the only place a sink failure could be reported, so the console is all
      // that is left. Reported once, then the sink goes quiet.
      onFailure: (err) => console.error('[intersect] log sink unavailable in core:', err)
    })
  return createLogger({
    sink,
    level: parseLevel(opts.env.INTERSECT_LOG_LEVEL, defaultLevel(opts.env)),
    proc: 'core',
    scope: 'lifecycle',
    now: opts.now
  })
}

/**
 * Record the failures nobody wrote a handler for. An uncaught exception has already left the
 * process in an undefined state, so it is logged and then handed to `onFatal` to die as before -
 * the host still observes the exit, but now with a cause on disk. A rejection is not fatal on its
 * own and only gets recorded.
 */
export function installCoreGlobalHandlers(logger: Logger, onFatal?: () => void): void {
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err })
    onFatal?.()
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason })
  })
}
```

- [ ] **Step 4: Wire it into `src/core/index.ts`**

Import at the top:

```ts
import { createCoreLogger, installCoreGlobalHandlers } from './logging'
```

Inside the `parentPort.on('message', ...)` handler, immediately after `const port = event.ports[0]` and its guard, before `new PortRpc(port)`:

```ts
  const logger = createCoreLogger({ userDataDir: message.userDataDir!, env: process.env })
  // A crash here would otherwise be reported to the host as a bare exit code with no cause.
  installCoreGlobalHandlers(logger, () => process.exit(1))
  logger.info('core starting', { data: { pid: process.pid } })
```

Pass the logger into the transport:

```ts
  const rpc = new PortRpc(port, { logger: logger.child('rpc') })
```

Log the bootstrap outcome. Replace the existing `try`/`catch` tail:

```ts
    rpc.push(CORE_READY_PUSH, null)
    logger.info('core ready')
  } catch (err) {
    logger.error('core bootstrap failed', { err })
    // Stay alive so the failure push reaches main; main owns the decision to kill us.
    const payload: CoreFailedPayload = {
      message: err instanceof Error ? err.message : String(err)
    }
    rpc.push(CORE_FAILED_PUSH, payload)
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/logging/index.test.ts src/core/`
Expected: PASS. Existing core tests stay green.

- [ ] **Step 6: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/core/logging src/core/index.ts
git commit -m "feat(logging): core process logger and global error handlers"
```

---

### Task 8: The main process logger and the renderer receiver

**Files:**
- Create: `src/main/logging/index.ts`
- Test: `src/main/logging/index.test.ts`
- Modify: `src/main/index.ts`, `src/main/coreHost.ts`, `src/main/ipc/bridge.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `createMainLogger(opts: { userDataDir: string; env: NodeJS.ProcessEnv; sink?: LogSink; now?: () => Date }): Logger`, `installMainGlobalHandlers(logger: Logger): void`, `registerRendererLogReceiver(deps: { ipcMain: Pick<IpcMain, 'on'>; sink: LogSink; logger: Logger }): void`, `pruneLogsOnStartup(userDataDir: string, logger: Logger, now?: () => Date): void`.

The receiver validates records instead of trusting them: the renderer is the least trusted process, and a malformed record must not corrupt the file.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/logging/index.test.ts
import { describe, expect, it, vi } from 'vitest'
import { RENDERER_LOG_CHANNEL } from '@common/logging/channel'
import type { LogSink } from '@common/logging/logger'
import { createMainLogger, registerRendererLogReceiver } from './index'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function records(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Captures the single handler the receiver registers so tests can drive it. */
function fakeIpcMain(): {
  on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => void
  emit: (channel: string, ...args: unknown[]) => void
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    on: (channel, handler) => void handlers.set(channel, handler),
    emit: (channel, ...args) => handlers.get(channel)?.({}, ...args)
  }
}

describe('createMainLogger', () => {
  it('stamps every record as the main process', () => {
    const sink = fakeSink()
    createMainLogger({ userDataDir: '/tmp/x', env: {}, sink }).info('window opened')
    expect(records(sink)[0]).toMatchObject({ proc: 'main' })
  })
})

describe('registerRendererLogReceiver', () => {
  it('appends a well-formed renderer record verbatim', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'error',
      proc: 'renderer',
      pid: 1,
      scope: 'renderer',
      msg: 'boundary caught a render failure'
    })
    expect(records(sink)[0]).toMatchObject({
      proc: 'renderer',
      level: 'error',
      msg: 'boundary caught a render failure'
    })
  })

  it('rejects a record with an unknown level instead of writing it', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, { level: 'catastrophe', msg: 'x' })
    expect(sink.lines).toEqual([])
  })

  it('forces proc to renderer even if the payload claims otherwise', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
    })
    ipcMain.emit(RENDERER_LOG_CHANNEL, {
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      proc: 'core',
      pid: 9,
      scope: 'renderer',
      msg: 'spoofed'
    })
    expect(records(sink)[0].proc).toBe('renderer')
  })

  it('ignores a non-object payload without throwing', () => {
    const sink = fakeSink()
    const ipcMain = fakeIpcMain()
    registerRendererLogReceiver({
      ipcMain,
      sink,
      logger: createMainLogger({ userDataDir: '/tmp/x', env: {}, sink: fakeSink() })
    })
    expect(() => ipcMain.emit(RENDERER_LOG_CHANNEL, 'garbage')).not.toThrow()
    expect(sink.lines).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/logging/index.test.ts`
Expected: FAIL - cannot resolve `./index`.

- [ ] **Step 3: Implement `src/main/logging/index.ts`**

```ts
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { RENDERER_LOG_CHANNEL } from '@common/logging/channel'
import {
  createFileSink,
  DEFAULT_RETENTION_DAYS,
  LOG_DIR_NAME,
  pruneOldLogs
} from '@common/logging/fileSink.node'
import { createLogger, parseLevel, type Logger, type LogSink } from '@common/logging/logger'
import {
  LEVEL_ORDER,
  serialize,
  type LogLevel,
  type LogRecord,
  type LogScope
} from '@common/logging/record'

/**
 * Electron main's diagnostic surface, plus the log file's two main-only responsibilities: pruning
 * old files at startup, and appending the records the sandboxed renderer cannot write itself.
 */

export interface MainLoggerOptions {
  userDataDir: string
  env: NodeJS.ProcessEnv
  /** Injected in tests; production opens the shared daily file. */
  sink?: LogSink
  now?: () => Date
}

function defaultLevel(env: NodeJS.ProcessEnv): LogLevel {
  return env.NODE_ENV === 'production' ? 'info' : 'debug'
}

export function createMainSink(userDataDir: string, now?: () => Date): LogSink {
  return createFileSink({
    dir: join(userDataDir, LOG_DIR_NAME),
    now,
    onFailure: (err) => console.error('[intersect] log sink unavailable in main:', err)
  })
}

export function createMainLogger(opts: MainLoggerOptions): Logger {
  return createLogger({
    sink: opts.sink ?? createMainSink(opts.userDataDir, opts.now),
    level: parseLevel(opts.env.INTERSECT_LOG_LEVEL, defaultLevel(opts.env)),
    proc: 'main',
    scope: 'lifecycle',
    now: opts.now
  })
}

export function installMainGlobalHandlers(logger: Logger): void {
  process.on('uncaughtException', (err) => logger.error('uncaught exception', { err }))
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { err: reason }))
}

/**
 * Delete log files past the retention window. Main is the sole owner: it starts before the core and
 * outlives it, so no two processes can race on the same delete.
 */
export function pruneLogsOnStartup(userDataDir: string, logger: Logger, now?: () => Date): void {
  const removed = pruneOldLogs(
    join(userDataDir, LOG_DIR_NAME),
    now?.() ?? new Date(),
    DEFAULT_RETENTION_DAYS
  )
  if (removed.length > 0) {
    logger.info('pruned expired log files', { data: { count: removed.length } })
  }
}

const SCOPES: ReadonlySet<string> = new Set<LogScope>([
  'rpc',
  'http',
  'mcp',
  'db',
  'pty',
  'jira',
  'ado',
  'lifecycle',
  'attention',
  'agentRuntime',
  'oneOnOne',
  'settings',
  'renderer',
  'log'
])

/**
 * Accept a renderer record only when it has the exact shape of one. The renderer is the least
 * trusted process and its records reach the file unmodified, so a malformed payload is dropped
 * rather than appended - one bad line would break every reader that parses the file line by line.
 */
function validate(payload: unknown): LogRecord | null {
  if (typeof payload !== 'object' || payload === null) return null
  const r = payload as Partial<LogRecord>
  if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts))) return null
  if (typeof r.level !== 'string' || !(r.level in LEVEL_ORDER)) return null
  if (typeof r.scope !== 'string' || !SCOPES.has(r.scope)) return null
  if (typeof r.msg !== 'string') return null
  const record: LogRecord = {
    ts: r.ts,
    level: r.level as LogLevel,
    // Never taken from the payload: a renderer must not be able to attribute a record elsewhere.
    proc: 'renderer',
    pid: typeof r.pid === 'number' ? r.pid : 0,
    scope: r.scope as LogScope,
    msg: r.msg
  }
  if (r.data !== undefined && typeof r.data === 'object' && r.data !== null) record.data = r.data
  if (r.err !== undefined && typeof r.err === 'object' && r.err !== null) record.err = r.err
  return record
}

export interface RendererLogReceiverDeps {
  ipcMain: Pick<IpcMain, 'on'>
  sink: LogSink
  /** Main's own logger, used to report a payload that did not validate. */
  logger: Logger
}

export function registerRendererLogReceiver(deps: RendererLogReceiverDeps): void {
  const log = deps.logger.child('log')
  deps.ipcMain.on(RENDERER_LOG_CHANNEL, (_event, payload: unknown) => {
    const record = validate(payload)
    if (!record) {
      log.warn('discarded a malformed renderer log record')
      return
    }
    try {
      deps.sink.write(serialize(record))
    } catch {
      // The sink reports its own failure once; a renderer record must never break the receiver.
    }
  })
}
```

- [ ] **Step 4: Wire it into `src/main/index.ts`**

Add the import:

```ts
import {
  createMainLogger,
  createMainSink,
  installMainGlobalHandlers,
  pruneLogsOnStartup,
  registerRendererLogReceiver
} from './logging'
```

Add a module-level holder beside the other `let` declarations:

```ts
let log: Logger | null = null
```

with `import type { Logger } from '@common/logging/logger'`.

In `app.whenReady().then(...)`, before `wireCore(userDataDir)`:

```ts
  const sink = createMainSink(userDataDir)
  log = createMainLogger({ userDataDir, env: process.env, sink })
  installMainGlobalHandlers(log)
  pruneLogsOnStartup(userDataDir, log)
  registerRendererLogReceiver({ ipcMain, sink, logger: log })
  log.info('app ready', { data: { userDataDir, packaged: app.isPackaged } })
```

Replace the three existing `console.error` calls:

- `notification.on('failed', ...)` becomes
  `notification.on('failed', (_e, error) => log?.error('native notification failed', { data: { sessionId: request.sessionId }, err: error }))`
- the `restarting` branch becomes
  `log?.error('core crashed, restarting', { data: { attempt: status.attempt, message: status.message } })`
- the `failed` branch becomes
  `log?.error('core failed', { data: { message: status.message } })`

Add an `info` for the healthy transition inside `onStatus`:

```ts
      if (status.state === 'ready') log?.info('core ready')
```

- [ ] **Step 5: Replace the remaining `console.error` calls in main**

In `src/main/coreHost.ts`, add an optional `logger` to `CoreHostDeps`:

```ts
  /** Records push-handler faults, which have nowhere else to surface. */
  logger?: Logger
```

and replace the `console.error('[coreHost] push handler threw:', err)` with
`deps.logger?.error('core push handler threw', { data: { channel }, err })`.

In `src/main/ipc/bridge.ts`, add `logger?: Logger` to `CoreBridgeDeps` and replace
`console.error(\`[bridge] unroutable core push: ${channel}\`)` with
`deps.logger?.error('unroutable core push', { data: { channel } })`.

Pass `logger: log.child('lifecycle')` from `wireCore` into both `createCoreHost` and
`registerCoreBridge`. Change `wireCore(userDataDir: string)` to `wireCore(userDataDir: string, logger: Logger)` and pass `log` at the call site.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/main/`
Expected: PASS. Existing `coreHost` and `bridge` tests stay green because `logger` is optional.

- [ ] **Step 7: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/main
git commit -m "feat(logging): main process logger, retention prune and renderer receiver"
```

---

### Task 9: The renderer logger

**Files:**
- Create: `src/renderer/src/shared/logging/logger.ts`
- Test: `src/renderer/src/shared/logging/logger.test.ts`
- Modify: `src/common/ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/shared/ui/toast.ts`, `src/renderer/src/shared/ui/ErrorBoundary.tsx`, `src/renderer/src/shared/store/createStore.ts`, `src/renderer/src/features/prInbox/store.ts`, `src/renderer/src/app` entry

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces: `rendererLogger(): Logger`, `initRendererLogging(opts?: { level?: LogLevel; win?: Window; console?: Pick<Console, 'error' | 'warn'> }): Logger`.

Adds to `IpcApi`:

```ts
  log: {
    /** Fire-and-forget: a log record must never make the renderer wait. */
    write(record: unknown): void
  }
```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/renderer/src/shared/logging/logger.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initRendererLogging, rendererLogger } from './logger'

const written: unknown[] = []

beforeEach(() => {
  written.length = 0
  ;(window as unknown as { intersect: unknown }).intersect = {
    log: { write: (record: unknown) => void written.push(record) }
  }
})

function records(): Array<Record<string, unknown>> {
  return written as Array<Record<string, unknown>>
}

describe('initRendererLogging', () => {
  it('ships records through the preload bridge stamped as the renderer', () => {
    initRendererLogging().child('renderer').error('something broke')
    expect(records()[0]).toMatchObject({ proc: 'renderer', level: 'error', msg: 'something broke' })
  })

  it('records an uncaught error reaching window.onerror', () => {
    initRendererLogging()
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', filename: 'a.js', lineno: 3, error: new Error('boom') })
    )
    const rec = records().find((r) => r.msg === 'uncaught error')
    expect(rec).toMatchObject({ level: 'error' })
    expect((rec?.err as { message: string }).message).toBe('boom')
  })

  it('records an unhandled rejection', () => {
    initRendererLogging()
    // jsdom does not fire PromiseRejectionEvent on its own, so dispatch it directly.
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new Error('dangling')
    window.dispatchEvent(event)
    expect(records().some((r) => r.msg === 'unhandled rejection')).toBe(true)
  })

  it('mirrors a library console.error into the log', () => {
    const native = { error: vi.fn(), warn: vi.fn() }
    initRendererLogging({ console: native })
    console.error('React key warning')
    expect(records().some((r) => r.msg === 'console.error')).toBe(true)
    // The original console still receives the call, so devtools is unchanged.
    expect(native.error).toHaveBeenCalledWith('React key warning')
  })

  it('does not recurse when the sink itself logs to console', () => {
    ;(window as unknown as { intersect: unknown }).intersect = {
      log: {
        write: () => {
          console.error('sink is broken')
        }
      }
    }
    const native = { error: vi.fn(), warn: vi.fn() }
    initRendererLogging({ console: native })
    expect(() => console.error('first')).not.toThrow()
  })

  it('survives a missing preload bridge', () => {
    delete (window as unknown as { intersect?: unknown }).intersect
    expect(() => initRendererLogging().error('no bridge')).not.toThrow()
  })
})

describe('rendererLogger', () => {
  it('returns the initialised instance', () => {
    const created = initRendererLogging()
    expect(rendererLogger()).toBe(created)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/shared/logging/logger.test.ts`
Expected: FAIL - cannot resolve `./logger`.

- [ ] **Step 3: Add the `log` surface to `ipc.ts` and preload**

In `src/common/ipc.ts`, add to `IpcApi`:

```ts
  log: {
    /**
     * Hand one already-serialised log record to Electron main, which owns the file. Fire-and-forget
     * by design: the renderer is sandboxed and cannot write the file itself, and a diagnostic must
     * never make the UI wait on I/O.
     */
    write(record: unknown): void
  }
```

In `src/preload/index.ts`, add the import and the namespace:

```ts
import { RENDERER_LOG_CHANNEL } from '@common/logging/channel'
```

```ts
  log: {
    write: (record) => ipcRenderer.send(RENDERER_LOG_CHANNEL, record)
  },
```

- [ ] **Step 4: Implement `src/renderer/src/shared/logging/logger.ts`**

```ts
import { createLogger, type Logger, type LogSink } from '@common/logging/logger'
import type { LogLevel, LogRecord } from '@common/logging/record'

/**
 * The renderer's diagnostic surface.
 *
 * A sandboxed renderer has no filesystem access, so records travel to Electron main over the
 * preload bridge and main appends them. Records are handed over as objects rather than serialised
 * lines: main validates them before writing, because the renderer is the least trusted producer
 * and one malformed line would break every reader that parses the file line by line.
 */

let instance: Logger | null = null

interface Bridge {
  log?: { write(record: unknown): void }
}

/**
 * Ship records through preload. A record produced before preload has attached, or in a test
 * without the bridge, is discarded rather than throwing: the renderer must run without a log.
 */
function createIpcSink(): LogSink {
  return {
    write(line) {
      const bridge = (window as unknown as { intersect?: Bridge }).intersect
      if (!bridge?.log) return
      bridge.log.write(JSON.parse(line) as LogRecord)
    }
  }
}

export interface RendererLoggingOptions {
  level?: LogLevel
  /** Injected in tests to observe mirroring without touching the real console. */
  console?: Pick<Console, 'error' | 'warn'>
}

/**
 * Build the renderer logger and attach the global failure handlers.
 *
 * `console.error` and `console.warn` are mirrored because React, xterm and Monaco report real
 * problems there and the app itself never calls them (ESLint forbids it). The mirror is guarded
 * against re-entry: a sink that itself logs to the console would otherwise recurse until the stack
 * gave out.
 */
export function initRendererLogging(opts: RendererLoggingOptions = {}): Logger {
  const native = opts.console ?? { error: console.error.bind(console), warn: console.warn.bind(console) }
  const logger = createLogger({
    sink: createIpcSink(),
    level: opts.level ?? 'debug',
    proc: 'renderer',
    pid: 0,
    scope: 'renderer'
  })
  instance = logger
  const log = logger.child('renderer')

  window.addEventListener('error', (event) => {
    const e = event as ErrorEvent
    log.error('uncaught error', {
      data: { filename: e.filename, lineno: e.lineno, colno: e.colno },
      err: e.error ?? e.message
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    log.error('unhandled rejection', { err: (event as { reason?: unknown }).reason })
  })

  let mirroring = false
  const mirror = (level: 'error' | 'warn') => {
    return (...args: unknown[]): void => {
      native[level](...args)
      if (mirroring) return
      mirroring = true
      try {
        log[level](`console.${level}`, { data: { args: args.map((a) => String(a)).slice(0, 5) } })
      } finally {
        mirroring = false
      }
    }
  }
  console.error = mirror('error')
  console.warn = mirror('warn')

  return logger
}

/**
 * The initialised renderer logger. Falls back to an inert instance so a component that logs during
 * a test which never called `initRendererLogging` does not crash.
 */
export function rendererLogger(): Logger {
  return instance ?? (instance = createLogger({ sink: createIpcSink(), level: 'debug', proc: 'renderer', pid: 0, scope: 'renderer' }))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/shared/logging/logger.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Call it from the renderer entry and replace the renderer's `console.*`**

In `src/renderer/src/main.tsx` (which calls `createRoot` at line 36), call `initRendererLogging()` before the `createRoot(root).render(...)` call, so a failure during the first render is already captured.

Replace the four renderer `console.*` sites:

- `src/renderer/src/shared/ui/toast.ts:31` - `rendererLogger().child('renderer').error(message, { err: error })`, keeping the toast push unchanged.
- `src/renderer/src/shared/ui/ErrorBoundary.tsx:58` - `rendererLogger().child('renderer').error('error boundary caught a failure', { data: { scope: this.props.scope, componentStack: info.componentStack }, err: error })`. Delete the now-false comment claiming the renderer has no log channel.
- `src/renderer/src/shared/store/createStore.ts:58` - `rendererLogger().child('renderer').error(message)`.
- `src/renderer/src/features/prInbox/store.ts:210` - `rendererLogger().child('prInbox' as never)` is wrong; use `rendererLogger().child('renderer').warn('background PR sync failed', { err: e })`.

- [ ] **Step 7: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/common/ipc.ts src/preload src/renderer
git commit -m "feat(logging): renderer logger over the preload bridge"
```

---

### Task 10: MCP and child-process instrumentation

**Files:**
- Modify: `src/core/prInbox/adoClient.ts`, `src/core/bootstrap.ts`
- Test: `src/core/prInbox/adoClient.logging.test.ts`

**Interfaces:**
- Consumes: `Logger` from Task 2, `summarizeArgs` from Task 1, `withHttpLogging` from Task 6.
- Produces: an optional third parameter on `createAdoClient(resolveConfig?, ensureEnv?, logger?)`.

Azure DevOps is reached over an MCP stdio child, not HTTP, so `callTool` is the only place ADO traffic is observable.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/prInbox/adoClient.logging.test.ts
import { describe, expect, it } from 'vitest'
import { createLogger, type LogSink } from '@common/logging/logger'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

function records(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * `createAdoClient` spawns a real stdio child, so these tests drive the logging decorator through
 * the exported helper instead of a live connection.
 */
import { withMcpLogging } from './adoClient'

describe('withMcpLogging', () => {
  it('logs a successful tool call at debug', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(
      async () => ({ ok: true }),
      createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' })
    )
    await call('repo_list_pull_requests', { project: 'p', top: 100 })
    expect(records(sink)[0]).toMatchObject({
      level: 'debug',
      scope: 'mcp',
      msg: 'mcp tool call',
      data: { tool: 'repo_list_pull_requests' }
    })
  })

  it('logs a failing tool call at error and rethrows', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(async () => {
      throw new Error('server died')
    }, createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' }))
    await expect(call('repo_list_pull_requests', {})).rejects.toThrow('server died')
    expect(records(sink)[0]).toMatchObject({ level: 'error', msg: 'mcp tool call failed' })
  })

  it('summarises arguments rather than logging their values', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(
      async () => null,
      createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' })
    )
    await call('pr_create_comment', { body: 'a private review remark' })
    expect(sink.lines.join()).not.toContain('a private review remark')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/prInbox/adoClient.logging.test.ts`
Expected: FAIL - `withMcpLogging` is not exported.

- [ ] **Step 3: Add `withMcpLogging` to `adoClient.ts` and use it**

```ts
import type { Logger } from '@common/logging/logger'
import { summarizeArgs } from '@common/logging/record'

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * Record every Azure DevOps tool call. ADO is reached over an MCP stdio child rather than HTTP, so
 * this is the only seam where its traffic is observable at all. Argument values are summarised, not
 * logged: they carry review comment bodies and repository identifiers.
 */
export function withMcpLogging(call: ToolCall, logger: Logger): ToolCall {
  return async (name, args) => {
    const startedAt = Date.now()
    const data = { tool: name, args: summarizeArgs(Object.values(args)) }
    try {
      const result = await call(name, args)
      logger.debug('mcp tool call', { data: { ...data, durationMs: Date.now() - startedAt } })
      return result
    } catch (err) {
      logger.error('mcp tool call failed', {
        data: { ...data, durationMs: Date.now() - startedAt },
        err
      })
      throw err
    }
  }
}
```

Add `logger?: Logger` as the third parameter of `createAdoClient` and route its `callTool` through the decorator when a logger is supplied. Log the stdio child's lifecycle too, inside `connect()`:

```ts
      logger?.info('mcp server spawned', { data: { command: config.command } })
```

and on teardown:

```ts
      logger?.warn('mcp server connection torn down', { data: { reason } })
```

- [ ] **Step 4: Wire the loggers through `bootstrap.ts`**

`createCoreRuntime` must accept the logger. Add `logger: Logger` to its deps interface, then:

- Wrap the injected Jira `fetch` at line 590:
  ```ts
    fetch: withHttpLogging(globalThis.fetch.bind(globalThis), deps.logger.child('http')),
  ```
- Pass `deps.logger.child('mcp')` into `createAdoClient`.
- Pass `deps.logger.child('rpc')` nowhere - the transport already has it from Task 7.
- Replace the seven existing `console.*` calls in `bootstrap.ts` with the equivalent scoped logger calls, preserving the level each already used (`console.log` becomes `info`, `console.warn` becomes `warn`).
- Replace `console.warn` in `src/core/myWork/jiraSyncEngine.ts:90` with a `jira`-scoped `warn`, `src/core/oneOnOne/otoManager.ts:303` with an `oneOnOne`-scoped `error`, `src/core/pty/terminalSnapshots.ts:56` with a `pty`-scoped `warn`, `src/core/prInbox/adoService.ts:175` with an `ado`-scoped `warn`, and `src/core/api/prInbox.ipc.ts:82`'s `warn` default with an injected logger call.
- In `src/core/index.ts`, pass `logger` into `createCoreRuntime`.
- Wrap the two remaining direct `fetch` defaults: `src/core/prInbox/adoVote.ts` and `src/core/settings/adoTestConnection.ts` receive their `fetchFn` from callers in `bootstrap.ts`; pass the already-wrapped fetch rather than letting them fall back to the global.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/`
Expected: PASS, including the pre-existing `src/core/bootstrap.test.ts`. It is the only test that constructs `createCoreRuntime`, so it needs a logger in its deps - use `createLogger({ sink: { write: () => {} }, level: 'error', proc: 'core' })` there.

- [ ] **Step 6: Verify the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/core
git commit -m "feat(logging): record MCP tool calls, HTTP and child process lifecycle"
```

---

### Task 11: Enforce the logger with ESLint

**Files:**
- Modify: `eslint.config.js`

**Interfaces:**
- Consumes: nothing.
- Produces: no exports. Two new rules.

Without `no-console`, `console.*` drifts back in and those lines never reach the file. The two sanctioned fallbacks are the sink-failure reporters, which cannot log through the logger they are reporting about.

- [ ] **Step 1: Add the rules**

Above the config array:

```js
// The logger is the only sanctioned diagnostic surface: a console call writes to a stream nobody
// reads in a packaged app, and never reaches the log file.
const NO_CONSOLE = {
  'no-console': 'error'
}

// Reporting that the log sink itself is unusable cannot go through the logger that depends on it.
const SINK_FALLBACK_FILES = [
  'src/core/logging/index.ts',
  'src/main/logging/index.ts'
]

// The file sink opens a descriptor with node:fs. The renderer is sandboxed and preload runs in a
// sandboxed context, so an import there is a build-time bundling error waiting to happen.
const NODE_FILE_SINK = {
  group: ['**/logging/fileSink.node'],
  message: 'fileSink.node.ts is Node-only. The renderer ships log records to main over the preload bridge instead.'
}
```

Add a block applying `no-console` to `src/**/*.{ts,tsx}`, a following block turning it off for `SINK_FALLBACK_FILES`, and add `NODE_FILE_SINK` to the `patterns` array of the existing renderer and `main/preload/renderer` blocks.

- [ ] **Step 2: Run lint to confirm it catches nothing left behind**

Run: `npm run lint`
Expected: PASS with zero errors. A failure here names a `console.*` call Tasks 7-10 missed - fix that call site rather than widening the exemption list.

- [ ] **Step 3: Verify the rule actually bites**

Temporarily add `console.log('x')` to `src/common/portRpc.ts`, run `npm run lint`, confirm it errors with the `no-console` rule, then remove the line.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run typecheck && npm test
git add eslint.config.js
git commit -m "chore(logging): forbid console and confine the Node file sink"
```

---

### Task 12: The debug launch script

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: an `npm run dev:debug` script.

- [ ] **Step 1: Add the script**

In `package.json`, beside `"dev"`:

```json
    "dev:debug": "electron-vite dev -- --remote-debugging-port=9222",
```

- [ ] **Step 2: Verify it opens the CDP endpoint**

Run `npm run dev:debug`, then in another shell:

```bash
curl -s http://127.0.0.1:9222/json/version
```

Expected: a JSON object naming the Electron build. Quit the app afterwards.

If the endpoint does not come up, the `--` separator is not forwarding the switch. Fall back to setting it in `src/main/index.ts` behind an env guard, before `app.whenReady()`:

```ts
if (process.env.INTERSECT_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.INTERSECT_DEBUG_PORT)
}
```

and make the script `INTERSECT_DEBUG_PORT=9222 electron-vite dev`.

- [ ] **Step 3: Document the log file and the debug port**

Add to `README.md`, under the scripts table:

```markdown
### Diagnostics

Structured logs are written as one JSON object per line to
`~/Library/Application Support/Intersect/logs/intersect-<date>.jsonl`, covering Electron main, the
headless core, and the renderer. Records from all three processes interleave, so sort by `ts`:

```bash
cat ~/Library/Application\ Support/Intersect/logs/intersect-*.jsonl \
  | jq -s 'sort_by(.ts) | .[] | select(.level == "error")'
```

`INTERSECT_LOG_LEVEL` sets the floor (`error`, `warn`, `info`, `debug`); it defaults to `debug` in
development and `info` when packaged. Files older than 7 days are pruned at startup.

`npm run dev:debug` additionally exposes the renderer on `http://127.0.0.1:9222` for a Chrome
DevTools client.
```

Also add a `dev:debug` row to the scripts table.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run typecheck && npm test
git add package.json README.md
git commit -m "docs(logging): document the log file and add a debug launch script"
```

---

### Task 13: End-to-end proof the pipeline works

**Files:**
- Create: `e2e/logging.spec.ts`

**Interfaces:**
- Consumes: the harness's `launch`, `userDataDir`, `test`, `expect`.
- Produces: nothing.

This is the only test that proves the renderer-to-main hop works in the real sandboxed runtime. Unit tests cannot establish it.

- [ ] **Step 1: Write the failing test**

```ts
// e2e/logging.spec.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launch, test, userDataDir } from './harness'

interface Record {
  ts: string
  level: string
  proc: string
  scope: string
  msg: string
}

/** Every record in the profile's log directory, parsed line by line. */
function readLog(profileDir: string): Record[] {
  const dir = join(profileDir, 'logs')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record)
    )
}

test('every process writes structured records to one log file', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir, { openOther: true })

  // Drive one real cross-process round trip so the core and the RPC seam have something to record.
  await win.locator('.ix-rail__btn', { hasText: 'TODO' }).click()
  await win.waitForSelector('.ix-todo')

  // The renderer's records travel over IPC, so give main a moment to append them.
  await expect
    .poll(() => readLog(profileDir).map((r) => r.proc), { timeout: 10_000 })
    .toContain('renderer')

  const records = readLog(profileDir)

  // All three producers reached the same file.
  expect(new Set(records.map((r) => r.proc))).toEqual(new Set(['main', 'core', 'renderer']))

  // Every line is a complete, well-formed record - which is what makes the file machine-readable.
  for (const record of records) {
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(['error', 'warn', 'info', 'debug']).toContain(record.level)
    expect(typeof record.msg).toBe('string')
  }

  // The RPC seam recorded the traffic the click generated.
  expect(records.some((r) => r.scope === 'rpc')).toBe(true)

  // Nothing failed during a clean boot and one navigation.
  expect(records.filter((r) => r.level === 'error')).toEqual([])

  await app.close()
})

test('the terminal fast path is never logged', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir, { openOther: true })

  await win.locator('.ix-rail__btn', { hasText: 'TODO' }).click()
  await win.waitForSelector('.ix-todo')

  // terminal:input and terminal:data would flood the file and throttle the terminal itself.
  const channels = readLog(profileDir)
    .map((r) => (r as unknown as { data?: { channel?: string } }).data?.channel)
    .filter((channel): channel is string => typeof channel === 'string')
  expect(channels).not.toContain('terminal:input')
  expect(channels).not.toContain('terminal:data')

  await app.close()
})
```

- [ ] **Step 2: Build and run the spec to verify it fails**

Run: `npm run build && npx playwright test e2e/logging.spec.ts`
Expected: FAIL before Tasks 7-9 are complete. After them it should pass.

- [ ] **Step 3: Make it pass**

If `renderer` never appears, the entry is not calling `initRendererLogging()` or preload is not exposing `log`. If `error` records appear on a clean boot, that is a real defect this task just found - fix the cause, do not relax the assertion.

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test && npm run e2e`
Expected: all green. Baseline for comparison: 1991 unit tests, 66 e2e passed with 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add e2e/logging.spec.ts
git commit -m "test(e2e): all three processes write valid records to one log file"
```

---

### Task 14: Open the pull request

- [ ] **Step 1: Confirm every gate is green**

```bash
npm run lint && npm run typecheck && npm test && npm run e2e
```

- [ ] **Step 2: Confirm no `console.*` survives outside the two fallbacks**

```bash
grep -rnE "console\.(error|warn|log|debug|info)\(" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected: exactly two lines, both in `src/core/logging/index.ts` and `src/main/logging/index.ts`.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feature/structured-logging
gh pr create --title "feat: structured logging and diagnostics (infrastructure)" --body "$(cat <<'BODY'
## Summary

Gives Intersect a durable, field-oriented JSONL log across all three processes. Before this, there
was no log file, no logging library, no level control, and no global error handler anywhere - a
crash left either silence or a dead process whose output went nowhere.

- `<userData>/logs/intersect-<date>.jsonl`, one JSON object per line, 7-day retention
- Main and core append directly with `O_APPEND`; the sandboxed renderer ships records to main
- Instrumented: RPC (excluding the terminal fast path), HTTP, MCP tool calls, child process
  lifecycle, and uncaught exceptions and rejections in every process
- Secrets redacted at the serializer; PTY output never logged as content
- `no-console` in ESLint so the logger cannot be bypassed
- `npm run dev:debug` exposes the renderer for a Chrome DevTools client

Design: `docs/superpowers/specs/2026-07-28-structured-logging-design.md`

The 118 discarded errors (`catch {}` and `.catch(() => {})`) are deliberately left for a follow-up
PR so this one stays reviewable.

## Test plan

- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run e2e`
- [x] New e2e spec asserts all three processes reach one valid JSONL file

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-Review

**Spec coverage:** Sink and daily file (Task 3), record shape and scope union (Task 1), the
`Channel`-enum trap (Task 4), RPC instrumentation with PTY exclusion (Tasks 4, 5), HTTP (Task 6),
MCP and spawns (Task 10), core logger and handlers (Task 7), main logger, prune and renderer
receiver (Task 8), renderer logger with `window.onerror`, `unhandledrejection` and console mirroring
(Task 9), levels and `INTERSECT_LOG_LEVEL` (Tasks 7, 8), redaction (Task 1), rate guard and
never-throw (Tasks 1, 2), `no-console` (Task 11), CDP access (Task 12), all three test tiers
(every task, plus Task 13). The 25 existing `console.*` sites are replaced across Tasks 5, 7, 8, 9
and 10, verified by the grep in Task 14. The 118 swallows are explicitly PR 2.

**Deviation from the spec, deliberate:** the spec lists `src/main/logging/index.ts` as owning the
receiver and says main "appends renderer records". The plan has it validate them first. A renderer
record reaching the file unchecked could write a malformed line and break every line-by-line reader,
so validation is load-bearing rather than defensive. Recorded here because it adds behaviour the
spec did not describe.

**Placeholder scan:** no TBD, no "add error handling", no "similar to Task N". Every code step
carries real code. Task 12 Step 2 has a conditional fallback, which is a genuine environment
uncertainty about switch forwarding with a stated remedy, not a placeholder.

**Type consistency:** `LogSink.write(line: string)` is used identically in Tasks 2, 3, 8 and 9.
`Logger` methods take `(msg, fields?)` everywhere. `createLogger` options match between Tasks 2, 7,
8 and 9. `summarizeArgs` returns `string[]` and is consumed that way in Tasks 5 and 10.
`normalizeError` is applied inside `createLogger`, so no call site passes an already-normalized
error - confirmed against Tasks 5, 6, 9 and 10, which all pass raw `err`. `serialize` is called by
the logger and by the main receiver only.

**One risk worth naming:** Task 10 changes `createCoreRuntime`'s deps, which `bootstrap.test.ts` and
`wire.test.ts` construct. Those two files need a no-op logger added; Step 5 says so explicitly. If a
subagent misses it, `npm test` fails loudly rather than silently, which is the right failure mode.
