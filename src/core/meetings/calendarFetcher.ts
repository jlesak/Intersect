import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpServerLaunch } from '../standaloneServerLaunch'
import { buildCalendarSpawnSpec } from './calendarSpawn'

type Launch = typeof nodeSpawn

export interface CalendarFetcherDeps {
  /** Excluded app data directory, so the hidden process creates no time card. */
  cwd: string
  claudePath: string
  reportServerPath: string
  execPath: string
  timeoutMs?: number
  /** Test-only launcher and fake account connector; production uses the user's connected account. */
  launch?: Launch
  syntheticMcpServers?: Record<string, unknown>
  strictMcpConfig?: boolean
}

export interface CalendarFetcher {
  fetch(day: string, signal?: AbortSignal): Promise<unknown>
  dispose(): void
}

const SECRET_ENV = /^AZURE_DEVOPS_|(^|_)(PAT|TOKEN|SECRET|PASSWORD|KEY|APIKEY|CREDENTIALS?)($|_)/i
const isSecretKey = (key: string): boolean =>
  SECRET_ENV.test(key) && !/^(ANTHROPIC|CLAUDE)_/i.test(key)

function sessionEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ELECTRON_') && !isSecretKey(key)) env[key] = value
  }
  // Official Claude CLI docs: skip local prompt history and session transcripts in any mode.
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
  return env
}

async function settingsShadow(): Promise<Record<string, string>> {
  try {
    const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as
      { env?: Record<string, unknown> }
    return Object.fromEntries(Object.keys(settings.env ?? {}).filter(isSecretKey).map(key => [key, '']))
  } catch { return {} }
}

function userMessage(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

function stop(proc: ChildProcessWithoutNullStreams): void {
  try { proc.stdin.end() } catch { /* already closed */ }
  try { proc.kill() } catch { /* already exited */ }
}

/** One bounded print-mode Claude process. The first turn lets account MCP tools finish loading. */
export function createCalendarFetcher(d: CalendarFetcherDeps): CalendarFetcher {
  const live = new Set<ChildProcessWithoutNullStreams>()
  const timeoutMs = d.timeoutMs ?? 40_000
  let disposed = false

  async function fetch(day: string, signal?: AbortSignal): Promise<unknown> {
    if (disposed) throw new Error('Calendar session is closed')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid calendar day')
    const id = randomUUID()
    const socketPath = join(tmpdir(), `imtg-${id.slice(0, 8)}.sock`)
    const configPath = join(tmpdir(), `imtg-${id.slice(0, 8)}.json`)
    let server: NetServer | undefined
    let proc: ChildProcessWithoutNullStreams | undefined
    let timeout: NodeJS.Timeout | undefined
    let rejectRun: ((reason: Error) => void) | undefined
    const aborted = (): void => rejectRun?.(new Error('Calendar refresh was cancelled'))
    try {
      let succeed!: (events: unknown) => void
      let fail!: (message: string) => void
      const result = new Promise<unknown>((resolve, reject) => {
        let finished = false
        succeed = (events): void => {
          if (finished) return
          finished = true
          resolve(events)
        }
        fail = (message): void => {
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
            } catch { /* malformed or unrelated report; timeout bounds this run */ }
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
        ...d.syntheticMcpServers,
        intersectMeetings: mcpServerLaunch(d.execPath, d.reportServerPath, {
          INTERSECT_MEETINGS_SOCK: socketPath, INTERSECT_MEETINGS_SESSION: id
        })
      } }), { mode: 0o600 })
      const spec = buildCalendarSpawnSpec({ claudePath: d.claudePath, mcpConfigPath: configPath,
        day, cwd: d.cwd, shadowEnv: await settingsShadow(), strictMcpConfig: d.strictMcpConfig })
      if (signal?.aborted) throw new Error('Calendar refresh was cancelled')
      proc = (d.launch ?? nodeSpawn)(spec.file, spec.args, {
        cwd: spec.cwd, env: sessionEnv(), stdio: 'pipe'
      })
      const child = proc
      live.add(child)
      signal?.addEventListener('abort', aborted, { once: true })
      let turn = 0
      let buffer = ''
      const send = (message: string): void => {
        if (!child.stdin.writable) { fail('Calendar connector session closed before reporting'); return }
        try { child.stdin.write(userMessage(message)) }
        catch { fail('Calendar connector session closed before reporting') }
      }
      child.stdin.on('error', () => fail('Calendar connector session closed before reporting'))
      child.stdout.on('data', (chunk: Buffer) => {
        // Process output can contain calendar subjects. Parse in memory; never log or persist it.
        buffer += chunk.toString('utf8')
        if (buffer.length > 2_000_000) { fail('Calendar connector output is too large'); return }
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          let event: Record<string, unknown>
          try { event = JSON.parse(line) as Record<string, unknown> }
          catch { continue }
          if (event.type === 'control_request') {
            fail('Calendar connector is waiting for permission')
          } else if (event.type === 'result') {
            turn++
            if (turn === 1) send(spec.prompt)
            else if (turn === 2) send(`Retry the calendar request for ${day} now that tools have loaded. Report the events or authentication error once.`)
            else fail('Calendar connector did not report (check Microsoft 365 authentication and connection)')
          }
        }
      })
      // stderr may contain sensitive connector diagnostics, so retain only a bounded failure hint.
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2048) })
      child.on('error', () => fail('Calendar connector could not start'))
      child.on('exit', () => fail(/permission/i.test(stderr)
        ? 'Calendar connector is waiting for permission'
        : 'Calendar connector session exited before reporting (check Microsoft 365 authentication)'))
      timeout = setTimeout(() => fail(
        'Calendar connector did not report in time (check authentication or connection)'
      ), timeoutMs)
      send('Do not call tools. Reply READY.')
      return await result
    } finally {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
      if (proc) { live.delete(proc); stop(proc) }
      server?.close()
      await rm(socketPath, { force: true }).catch(() => {})
      await rm(configPath, { force: true }).catch(() => {})
    }
  }

  return {
    fetch,
    dispose() { disposed = true; for (const proc of live) stop(proc) }
  }
}
