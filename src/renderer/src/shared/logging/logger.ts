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
 * problems there and the app itself never calls them. The mirror is guarded against re-entry: a
 * sink that itself logs to the console would otherwise recurse until the stack gave out.
 */
export function initRendererLogging(opts: RendererLoggingOptions = {}): Logger {
  const native = opts.console ?? {
    error: console.error.bind(console),
    warn: console.warn.bind(console)
  }
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
  return (
    instance ??
    (instance = createLogger({
      sink: createIpcSink(),
      level: 'debug',
      proc: 'renderer',
      pid: 0,
      scope: 'renderer'
    }))
  )
}
