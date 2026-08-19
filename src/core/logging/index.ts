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
  /** Whether this is a packaged app, reported by main in the init message. */
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
function defaultLevel(packaged: boolean): LogLevel {
  return packaged ? 'info' : 'debug'
}

/**
 * Build the logger the core process uses for its whole lifetime. The sink is injectable so tests
 * assert against memory, and production opens the shared daily file under the user data directory.
 */
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
    level: parseLevel(opts.env.INTERSECT_LOG_LEVEL, defaultLevel(opts.packaged)),
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
