import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyProcess, SpawnFn } from '../pty/sessionManager'
import { mcpServerLaunch } from '../standaloneServerLaunch'
import { buildCalendarSpawnSpec } from './calendarSpawn'

export interface CalendarFetcherDeps {
  spawn: SpawnFn
  /** Excluded app data directory, so this hidden session creates no time card. */
  cwd: string
  claudePath: string
  reportServerPath: string
  execPath: string
  timeoutMs?: number
  retryMs?: number
}

export interface CalendarFetcher {
  fetch(day: string, signal?: AbortSignal): Promise<unknown>
  dispose(): void
}

const SECRET_ENV = /^AZURE_DEVOPS_|(^|_)(PAT|TOKEN|SECRET|PASSWORD|KEY|APIKEY|CREDENTIALS?)($|_)/i
const isSecretKey = (key: string): boolean =>
  SECRET_ENV.test(key) && !/^(ANTHROPIC|CLAUDE)_/i.test(key)

function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ELECTRON_') && !isSecretKey(key)) env[key] = value
  }
  env.TERM = 'xterm-256color'
  return env
}

async function settingsShadow(): Promise<Record<string, string>> {
  try {
    const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as
      { env?: Record<string, unknown> }
    return Object.fromEntries(Object.keys(settings.env ?? {}).filter(isSecretKey).map(key => [key, '']))
  } catch { return {} }
}

/** One hidden interactive Claude session, bounded by the caller's abort and an internal timeout. */
export function createCalendarFetcher(d: CalendarFetcherDeps): CalendarFetcher {
  const live = new Set<PtyProcess>()
  const timeoutMs = d.timeoutMs ?? 40_000
  const retryMs = d.retryMs ?? 8_000
  let disposed = false

  async function fetch(day: string, signal?: AbortSignal): Promise<unknown> {
    if (disposed) throw new Error('Calendar session is closed')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid calendar day')
    const id = randomUUID()
    const socketPath = join(tmpdir(), `imtg-${id.slice(0, 8)}.sock`)
    const configPath = join(tmpdir(), `imtg-${id.slice(0, 8)}.json`)
    let server: NetServer | undefined
    let proc: PtyProcess | null = null
    let timeout: NodeJS.Timeout | undefined
    let retry: NodeJS.Timeout | undefined
    let rejectRun: ((reason: Error) => void) | undefined
    const aborted = (): void => rejectRun?.(new Error('Calendar refresh was cancelled'))
    try {
      let succeed!: (events: unknown) => void
      let fail!: (message: string) => void
      const result = new Promise<unknown>((resolve, reject) => {
        let finished = false
        succeed = (events: unknown): void => {
          if (finished) return
          finished = true
          resolve(events)
        }
        fail = (message: string): void => {
          if (finished) return
          finished = true
          reject(new Error(message))
        }
        rejectRun = (error) => fail(error.message)
      })
      server = createServer((conn) => {
          conn.on('error', () => {})
          let buffer = ''
          conn.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            if (buffer.length > 2_000_000) { fail('Calendar report is too large'); return }
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              try {
                const report = JSON.parse(line) as Record<string, unknown>
                if (report.sessionId !== id || report.day !== day) continue
                if (typeof report.error === 'string' && report.error) fail(report.error.slice(0, 500))
                else if (Array.isArray(report.events)) succeed(report.events)
                else fail('Calendar report has no event list')
              } catch { /* malformed or unrelated report; the timeout still bounds this run */ }
            }
          })
      })
      const listening = server
      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject)
        listening.listen(socketPath, () => { listening.off('error', reject); resolve() })
      })
      await chmod(socketPath, 0o600)
      await writeFile(configPath, JSON.stringify({ mcpServers: {
        intersectMeetings: mcpServerLaunch(d.execPath, d.reportServerPath, {
          INTERSECT_MEETINGS_SOCK: socketPath, INTERSECT_MEETINGS_SESSION: id
        })
      } }), { mode: 0o600 })
      const spec = buildCalendarSpawnSpec({ claudePath: d.claudePath, mcpConfigPath: configPath,
        day, cwd: d.cwd, shadowEnv: await settingsShadow() })
      if (signal?.aborted) throw new Error('Calendar refresh was cancelled')
      proc = d.spawn({ ...spec, cols: 200, rows: 50, env: sessionEnv() })
      live.add(proc)
      signal?.addEventListener('abort', aborted, { once: true })
      let output = ''
      proc.onData((chunk) => {
        // Never log or persist the terminal stream: it may contain calendar subjects.
        output = (output + chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-4096)
        if (/waiting for permission|permission required|needs your permission|allow this tool/i
          .test(output)) rejectRun?.(new Error('Calendar connector is waiting for permission'))
      })
      proc.onExit(() => rejectRun?.(new Error(
        'Calendar connector session exited before reporting (check Microsoft 365 authentication)'
      )))
      timeout = setTimeout(() => rejectRun?.(new Error(
        'Calendar connector did not report in time (check authentication or connection)'
      )), timeoutMs)
      // Interactive Claude can render the first prompt before its MCPs finish connecting. A
      // follow-up turn gives newly connected tools a chance to load without starting a new run.
      retry = setInterval(() => {
        try { proc?.write('The calendar and report tools may now be connected. Retry the requested day; report once or report the authentication/error.\r') }
        catch { /* exit/timeout handles a dead PTY */ }
      }, retryMs)
      return await result
    } finally {
      if (timeout) clearTimeout(timeout)
      if (retry) clearInterval(retry)
      signal?.removeEventListener('abort', aborted)
      if (proc) { live.delete(proc); try { proc.kill() } catch { /* already exited */ } }
      server?.close()
      await rm(socketPath, { force: true }).catch(() => {})
      await rm(configPath, { force: true }).catch(() => {})
    }
  }

  return {
    fetch,
    dispose() { disposed = true; for (const proc of live) { try { proc.kill() } catch { /* exited */ } } }
  }
}
