import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import { chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OtoRun, OtoRunType } from '@common/domain'
import type { OtoRunRepo } from '../db/otoRunRepo'
import type { PtyProcess, SpawnFn } from '../pty/sessionManager'
import { parseOtoReport, type OtoReportPayload } from './otoReport'
import { buildOtoSpawnSpec } from './otoSpawn'

export interface OtoManagerDeps {
  spawn: SpawnFn
  claudePath: string
  /** Absolute path to the built 1:1 report MCP server (out/main/otoReportServer.js). */
  reportServerPath: string
  runs: OtoRunRepo
  /** Broadcast a finished run to the renderer so the history refreshes live. */
  onRunChanged: (run: OtoRun) => void
  /** How long a Process run may take before it is killed and marked failed. */
  processTimeoutMs?: number
  /** How long a Prepare run may take before it is killed and marked failed. */
  prepTimeoutMs?: number
  /** Override for tests: the user settings file whose env block is scanned for secrets. */
  userSettingsPath?: string
}

/** The request the IPC layer hands to start(), already validated and enriched. */
export interface OtoStartRequest {
  type: OtoRunType
  person: string
  vttPath?: string | null
  /** Preformatted TODO mention lines for the Prepare prompt (empty for Process). */
  todoMentions: string[]
}

export interface OtoManager {
  /**
   * Persist a new `running` run, launch its hidden session in the background, and return the run
   * immediately. Each call gets its own independent session - concurrent runs are allowed.
   */
  start(req: OtoStartRequest): OtoRun
  /** Synchronous teardown for app quit: kill every live hidden session, no DB writes. */
  dispose(): void
}

const PROCESS_TIMEOUT_MS = 15 * 60_000
const PREP_TIMEOUT_MS = 8 * 60_000

/** Every temp file a 1:1 run creates carries this shape; nothing else in tmp may match it. */
const TEMP_FILE_PATTERN = /^ioto-[0-9a-f]{8}\.(sock|json)$/

/**
 * Remove 1:1 temp files a crashed or force-quit run left behind. Each run names its files after a
 * fresh UUID, so nothing else ever reclaims them. Only files old enough that no live run (which
 * the timeouts bound) can still own them are touched, so a second app instance is not disturbed.
 */
export async function sweepStaleOtoTempFiles(maxAgeMs = 30 * 60_000): Promise<void> {
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
const SECRET_ENV = /^AZURE_DEVOPS_|(^|_)(PAT|TOKEN|SECRET|PASSWORD|KEY|APIKEY|CREDENTIALS?)($|_)/i

const isSecretKey = (k: string): boolean => SECRET_ENV.test(k) && !/^(ANTHROPIC|CLAUDE)_/i.test(k)

function hygienicEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_')) continue
    // Strip credentials so a prompt-injected read/leak of the process env yields nothing useful.
    // ANTHROPIC_/CLAUDE_ auth vars are kept so the session can authenticate.
    if (isSecretKey(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

/**
 * Secret-looking keys the user's own settings.json `env` block would re-inject into the session
 * (these sessions load the user's settings by design, so stripping the spawn env alone is not
 * enough). Shadowing them to empty strings through the inline `--settings` source wins on
 * precedence, so the secrets never materialize inside the session.
 */
export async function secretShadowEnv(settingsPath: string): Promise<Record<string, string>> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env?: Record<string, unknown>
    }
    const shadow: Record<string, string> = {}
    for (const key of Object.keys(settings.env ?? {})) {
      if (isSecretKey(key)) shadow[key] = ''
    }
    return shadow
  } catch {
    // No settings file (or unreadable): nothing to shadow.
    return {}
  }
}

/** How one hidden session ended: with a matching report, or without one (exit/timeout/error). */
type SessionOutcome =
  | { kind: 'report'; payload: OtoReportPayload }
  | { kind: 'failed'; message: string }

interface Live {
  proc: PtyProcess
  socketServer: NetServer
}

/**
 * Owns the hidden interactive Claude Code sessions behind the two 1:1 workflows. Lifecycle of one
 * run: persist a `running` row, bind a Unix socket, write a temp MCP config pointing the report
 * server at it, spawn `claude` on a headless PTY, then land the first report whose sessionId and
 * tool match - or a failure when the PTY exits or the per-type timeout fires first. The outcome is
 * written back to the run row and broadcast; the PTY is always killed and the socket/config
 * removed afterwards. Runs are independent: any number may be live at once.
 */
export function createOtoManager(d: OtoManagerDeps): OtoManager {
  const live = new Map<string, Live>()
  // Set on app quit so late async completions never touch the closing database.
  let disposed = false

  void sweepStaleOtoTempFiles()

  /** Mark the run finished in the repo (unless the app is quitting) and broadcast the change. */
  function land(runId: string, outcome: SessionOutcome): void {
    if (disposed) return
    let updated: OtoRun
    if (outcome.kind === 'failed') {
      updated = d.runs.setFailed(runId, outcome.message)
    } else if (!outcome.payload.ok) {
      updated = d.runs.setFailed(runId, outcome.payload.error || 'The workflow reported a failure.')
    } else if (outcome.payload.tool === 'report_process_result') {
      updated = d.runs.setDone(runId, {
        type: 'process',
        notionUrl: outcome.payload.notionUrl || null,
        slackDraftCreated: outcome.payload.slackDraftCreated,
        slackChannelLink: outcome.payload.slackChannelLink || null
      })
    } else {
      updated = d.runs.setDone(runId, { type: 'prep', resultMarkdown: outcome.payload.markdown })
    }
    d.onRunChanged(updated)
  }

  async function runSession(run: OtoRun, req: OtoStartRequest): Promise<SessionOutcome> {
    const timeoutMs =
      run.type === 'process'
        ? (d.processTimeoutMs ?? PROCESS_TIMEOUT_MS)
        : (d.prepTimeoutMs ?? PREP_TIMEOUT_MS)
    const expectedTool = run.type === 'process' ? 'report_process_result' : 'report_prep_result'

    const sessionId = randomUUID()
    // Unix socket kept short and in tmp (macOS caps socket paths at ~104 bytes).
    const socketPath = join(tmpdir(), `ioto-${sessionId.slice(0, 8)}.sock`)
    const mcpConfigPath = join(tmpdir(), `ioto-${sessionId.slice(0, 8)}.json`)

    let socketServer: NetServer | null = null
    let proc: PtyProcess | null = null
    let timer: NodeJS.Timeout | null = null
    try {
      let resolveOutcome!: (outcome: SessionOutcome) => void
      const outcome = new Promise<SessionOutcome>((resolve) => (resolveOutcome = resolve))
      let done = false
      const finish = (o: SessionOutcome): void => {
        if (done) return
        done = true
        resolveOutcome(o)
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
              const payload = parseOtoReport(line)
              // Only this run's session may finish it.
              if (payload.sessionId !== sessionId) continue
              if (payload.tool !== expectedTool) {
                // The report server has already told the model to stop, so waiting longer would
                // only convert this into a misleading timeout minutes later.
                finish({
                  kind: 'failed',
                  message: `The session reported through the wrong tool (${payload.tool}).`
                })
                continue
              }
              finish({ kind: 'report', payload })
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
          intersectOneOnOne: {
            command: 'node',
            args: [d.reportServerPath],
            env: { INTERSECT_OTO_SOCK: socketPath, INTERSECT_OTO_SESSION: sessionId }
          }
        }
      }
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

      const spec = buildOtoSpawnSpec({
        type: run.type,
        person: run.person,
        vttPath: run.vttPath,
        todoMentions: req.todoMentions,
        claudePath: d.claudePath,
        mcpConfigPath,
        shadowEnv: await secretShadowEnv(
          d.userSettingsPath ?? join(homedir(), '.claude', 'settings.json')
        ),
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
      live.set(run.id, { proc, socketServer })

      // Hidden session: output is discarded and nothing is ever written to the PTY.
      proc.onData(() => {})
      proc.onExit(() =>
        finish({
          kind: 'failed',
          message: 'The background Claude Code session exited before reporting a result.'
        })
      )
      timer = setTimeout(
        () =>
          finish({
            kind: 'failed',
            message: `The workflow timed out after ${Math.round(timeoutMs / 60_000)} minutes.`
          }),
        timeoutMs
      )

      return await outcome
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      live.delete(run.id)
      try {
        proc?.kill()
      } catch {
        /* already dead */
      }
      socketServer?.close()
      await rm(socketPath, { force: true }).catch(() => {})
      await rm(mcpConfigPath, { force: true }).catch(() => {})
    }
  }

  return {
    start(req) {
      const run = d.runs.create({
        type: req.type,
        person: req.person,
        vttPath: req.type === 'process' ? (req.vttPath ?? null) : null
      })
      void runSession(run, req)
        .then((outcome) => land(run.id, outcome))
        .catch((err) => console.error('[intersect] 1:1 run bookkeeping failed:', err))
      return run
    },

    dispose() {
      disposed = true
      for (const current of live.values()) {
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
      live.clear()
    }
  }
}
