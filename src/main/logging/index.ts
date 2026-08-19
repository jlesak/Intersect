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
  isLevelEnabled,
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
  /** Whether this is a packaged app, which is what chooses the default floor. */
  packaged: boolean
  /** Injected in tests; production opens the shared daily file. */
  sink?: LogSink
  now?: () => Date
}

/**
 * The floor this run writes at. A packaged build keeps the file readable by holding back the
 * per-operation detail, while a development run wants all of it.
 *
 * Whether the app is packaged is asked of the host rather than read from `NODE_ENV`: nothing sets
 * that variable in an app launched from the Dock, so keying on it put every packaged run on the
 * development floor - the one configuration an end user actually has.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv, packaged: boolean): LogLevel {
  return parseLevel(env.INTERSECT_LOG_LEVEL, packaged ? 'info' : 'debug')
}

/**
 * Open main's handle on the shared daily file. Main needs the sink itself as well as the logger
 * built over it, because renderer records arrive already serialised and go straight to the sink.
 */
export function createMainSink(userDataDir: string, now?: () => Date): LogSink {
  return createFileSink({
    dir: join(userDataDir, LOG_DIR_NAME),
    now,
    // The log file is the only place a sink failure could be reported, so the console is all that
    // is left. Reported once, then the sink goes quiet.
    onFailure: (err) => console.error('[intersect] log sink unavailable in main:', err)
  })
}

/**
 * Build the logger Electron main uses for its whole lifetime. The sink is injectable so tests
 * assert against memory, and production shares one file handle with the renderer receiver.
 */
export function createMainLogger(opts: MainLoggerOptions): Logger {
  return createLogger({
    sink: opts.sink ?? createMainSink(opts.userDataDir, opts.now),
    level: resolveLogLevel(opts.env, opts.packaged),
    proc: 'main',
    scope: 'lifecycle',
    now: opts.now
  })
}

/**
 * Record the failures nobody wrote a handler for, and hand an uncaught exception to `onFatal`.
 *
 * Electron installs its own `uncaughtException` listener and that listener stands down as soon as a
 * second one exists, so registering this one takes away the native error box the user would
 * otherwise see. `onFatal` is where the caller puts that visible signal back: a crash the user
 * cannot see is a crash nobody reports. Reporting that itself fails is swallowed, because this is
 * the last handler in the process and a throw from here would end the run without a word.
 *
 * A rejection is recorded and goes no further, which is a deliberate difference: it leaves the
 * process in a state it can usually continue from, and a modal for every dangling promise would
 * cost more than the record it already writes.
 */
export function installMainGlobalHandlers(logger: Logger, onFatal?: (err: unknown) => void): void {
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err })
    try {
      onFatal?.(err)
    } catch {
      // The record above is already on disk, which is the part that has to survive.
    }
  })
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
 *
 * The level check is an own-property one so that a name every object inherits, such as
 * `constructor` or `toString`, is rejected like any other unrecognised value.
 */
function validate(payload: unknown): LogRecord | null {
  if (typeof payload !== 'object' || payload === null) return null
  const r = payload as Partial<LogRecord>
  if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts))) return null
  if (typeof r.level !== 'string' || !Object.prototype.hasOwnProperty.call(LEVEL_ORDER, r.level)) {
    return null
  }
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
  // The renderer redacted this record before serialising it, so the pass this process makes finds
  // the values already replaced and counts nothing. Carrying the count over is what keeps a
  // renderer record that held a credential distinguishable from one that never had any.
  if (typeof r.redactions === 'number' && Number.isInteger(r.redactions) && r.redactions > 0) {
    record.redactions = r.redactions
  }
  return record
}

export interface RendererLogReceiverDeps {
  ipcMain: Pick<IpcMain, 'on'>
  sink: LogSink
  /**
   * The floor this run writes at. The sandboxed renderer cannot read the environment, so the
   * configured level is applied here, by the process that resolved it and owns the file.
   */
  level: LogLevel
  /** Main's own logger, used to report a payload that did not validate. */
  logger: Logger
}

/**
 * Listen for the records the sandboxed renderer ships over IPC and append them on its behalf. The
 * renderer has no filesystem access, so this hop is the only route its diagnostics have to disk.
 */
export function registerRendererLogReceiver(deps: RendererLogReceiverDeps): void {
  const log = deps.logger.child('log')
  deps.ipcMain.on(RENDERER_LOG_CHANNEL, (_event, payload: unknown) => {
    const record = validate(payload)
    if (!record) {
      log.warn('discarded a malformed renderer log record')
      return
    }
    if (!isLevelEnabled(record.level, deps.level)) return
    try {
      deps.sink.write(serialize(record))
    } catch {
      // The sink reports its own failure once; a renderer record must never break the receiver.
    }
  })
}
