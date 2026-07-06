import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import { chmod, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JiraBoardResult } from '@common/domain'
import type { PtyProcess, SpawnFn } from '../pty/sessionManager'
import { toIssues } from './jiraMapping'
import { probeJiraSession, type JiraProbeResult } from './jiraProbe'
import { parseJiraReport } from './jiraReport'
import { buildJiraSpawnSpec, JIRA_FETCH_SCRIPT } from './jiraSpawn'

export interface JiraFetcherDeps {
  spawn: SpawnFn
  claudePath: string
  /** Absolute path to the built jira report MCP server (out/main/jiraReportServer.js). */
  reportServerPath: string
  /** How long the hidden session may run before it is killed and the fetch fails. */
  timeoutMs?: number
  /** Override for tests: the fast saved-session check run before spawning anything. */
  probe?: () => Promise<JiraProbeResult>
}

export interface JiraFetcher {
  /**
   * Run one hidden fetch session and resolve with its board result. Never rejects - every failure
   * (spawn, timeout, premature exit) becomes an `ok: false` result. Concurrent calls share the
   * session already in flight instead of spawning a second one.
   */
  fetchBoard(): Promise<JiraBoardResult>
  /** Synchronous teardown for app quit: kill the hidden session, if any. */
  dispose(): void
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000

/** Every temp file a fetch run creates carries this shape; nothing else in tmp may match it. */
const TEMP_FILE_PATTERN = /^imw-[0-9a-f]{8}\.(sock|json|py)$/

/**
 * Remove fetch temp files a crashed or force-quit run left behind. Each run names its files after
 * a fresh UUID, so nothing else ever reclaims them. Only files old enough that no live run (which
 * the timeout bounds) can still own them are touched, so a second app instance is not disturbed.
 */
export async function sweepStaleTempFiles(maxAgeMs = 30 * 60_000): Promise<void> {
  const dir = tmpdir()
  const names = await readdir(dir).catch(() => [] as string[])
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    if (!TEMP_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) await rm(path, { force: true })
    } catch {
      /* raced with another cleanup or vanished; nothing to do */
    }
  }
}

/** Keys that must never enter the hidden session's environment (any credential or secret). */
const SECRET_ENV = /^AZURE_DEVOPS_|(^|_)(PAT|TOKEN|SECRET|PASSWORD)($|_)/i

function hygienicEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_')) continue
    // Strip credentials so a prompt-injected read/leak of the process env yields nothing useful.
    // ANTHROPIC_/CLAUDE_ auth vars are kept so the session can authenticate.
    if (SECRET_ENV.test(k) && !/^(ANTHROPIC|CLAUDE)_/i.test(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

interface Live {
  proc: PtyProcess
  socketServer: NetServer
}

/**
 * Owns the hidden interactive Claude Code session that fetches the Jira board. Lifecycle of one
 * fetch: bind a Unix socket, write a temp MCP config pointing the session's only tool at it, spawn
 * `claude` on a headless PTY, then resolve with the first report message whose sessionId matches -
 * or with a failure when the PTY exits or the timeout fires first. The PTY is always killed and
 * the socket/config removed afterwards.
 */
export function createJiraFetcher(d: JiraFetcherDeps): JiraFetcher {
  const timeoutMs = d.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let live: Live | null = null
  let running: Promise<JiraBoardResult> | null = null

  void sweepStaleTempFiles()

  async function run(): Promise<JiraBoardResult> {
    // Without a working SSO session every fetch is guaranteed to fail; the sub-second probe
    // reports that as an auth failure right away, so the login window opens immediately instead
    // of after a whole hidden Claude session round-trip.
    const probe =
      d.probe ?? (() => probeJiraSession(join(homedir(), '.claude', 'jira', 'storageState.json')))
    if ((await probe()) === 'auth') {
      return { ok: false, kind: 'auth', message: 'Not logged in: no working Jira SSO session' }
    }

    const sessionId = randomUUID()
    // Unix socket kept short and in tmp (macOS caps socket paths at ~104 bytes).
    const socketPath = join(tmpdir(), `imw-${sessionId.slice(0, 8)}.sock`)
    const mcpConfigPath = join(tmpdir(), `imw-${sessionId.slice(0, 8)}.json`)
    const scriptPath = join(tmpdir(), `imw-${sessionId.slice(0, 8)}.py`)

    let socketServer: NetServer | null = null
    let proc: PtyProcess | null = null
    let timer: NodeJS.Timeout | null = null
    try {
      let resolveResult!: (result: JiraBoardResult) => void
      const result = new Promise<JiraBoardResult>((resolve) => (resolveResult = resolve))
      let done = false
      const finish = (r: JiraBoardResult): void => {
        if (done) return
        done = true
        resolveResult(r)
      }

      await rm(socketPath, { force: true }).catch(() => {})
      socketServer = createServer((conn) => {
        conn.on('error', () => {}) // a peer reset on session kill must not crash main
        let buffer = ''
        conn.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try {
              const payload = parseJiraReport(line)
              if (payload.sessionId !== sessionId) continue
              finish(
                payload.ok
                  ? { ok: true, issues: toIssues(payload.issues), fetchedAt: Date.now() }
                  : { ok: false, kind: payload.kind, message: payload.message || 'Jira fetch failed' }
              )
            } catch {
              // Ignore malformed report lines; the timeout still bounds the session.
            }
          }
        })
      })
      socketServer.on('error', () => {})
      const server = socketServer
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(socketPath, 0o600).catch(() => {})

      const mcpConfig = {
        mcpServers: {
          intersectJira: {
            command: 'node',
            args: [d.reportServerPath],
            env: { INTERSECT_JIRA_SOCK: socketPath, INTERSECT_JIRA_SESSION: sessionId }
          }
        }
      }
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })
      // Main owns the fetch script on disk; the session may only run this exact file, so a
      // prompt-injected session cannot substitute its own code.
      await writeFile(scriptPath, JIRA_FETCH_SCRIPT, { mode: 0o600 })

      const spec = buildJiraSpawnSpec({
        claudePath: d.claudePath,
        mcpConfigPath,
        pythonPath: join(homedir(), '.claude', 'skills', 'jira', '.venv', 'bin', 'python'),
        scriptPath,
        cwd: homedir()
      })
      proc = d.spawn({
        file: spec.file,
        args: spec.args,
        cwd: spec.cwd,
        cols: 200,
        rows: 50,
        env: hygienicEnv()
      })
      live = { proc, socketServer }

      // Hidden session: output is discarded and nothing is ever written to the PTY.
      proc.onData(() => {})
      proc.onExit(() =>
        finish({
          ok: false,
          kind: 'other',
          message: 'The background Claude Code session exited before reporting any issues.'
        })
      )
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            kind: 'other',
            message: `The Jira fetch timed out after ${Math.round(timeoutMs / 1000)}s.`
          }),
        timeoutMs
      )

      return await result
    } catch (err) {
      return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      live = null
      try {
        proc?.kill()
      } catch {
        /* already dead */
      }
      socketServer?.close()
      await rm(socketPath, { force: true }).catch(() => {})
      await rm(mcpConfigPath, { force: true }).catch(() => {})
      await rm(scriptPath, { force: true }).catch(() => {})
    }
  }

  return {
    fetchBoard() {
      if (!running) running = run().finally(() => (running = null))
      return running
    },

    dispose() {
      const current = live
      live = null
      if (!current) return
      try {
        current.socketServer.close()
      } catch {
        /* ignore */
      }
      try {
        current.proc.kill()
      } catch {
        /* ignore */
      }
    }
  }
}
