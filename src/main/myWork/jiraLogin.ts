import { spawn as nodeSpawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JiraLoginResult } from '@common/domain'

/**
 * Minimal surface of a spawned login process; injectable so tests never launch a real browser.
 */
export interface LoginProcess {
  on(event: 'exit', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(): void
}

export type LoginSpawnFn = (file: string, args: string[]) => LoginProcess

export interface JiraLoginDeps {
  spawn?: LoginSpawnFn
  /** Overrides for tests; default to the jira skill's venv python and login script. */
  pythonPath?: string
  scriptPath?: string
  /** The login script itself gives the user 5 minutes; this bounds a hung process beyond that. */
  timeoutMs?: number
}

export interface JiraLogin {
  /**
   * Run one interactive SSO login: a headed browser window opens and the user completes the
   * sign-in; the jira skill's script saves the session cookies on success. Never rejects.
   * Concurrent calls share the login already in flight instead of opening a second window.
   */
  login(): Promise<JiraLoginResult>
  /** Synchronous teardown for app quit: kill the login process, if any. */
  dispose(): void
}

const DEFAULT_TIMEOUT_MS = 6 * 60_000

const defaultSpawn: LoginSpawnFn = (file, args) =>
  nodeSpawn(file, args, { stdio: 'ignore', env: { ...process.env } })

/** Owns the interactive login window's process. At most one login runs at a time. */
export function createJiraLogin(d: JiraLoginDeps = {}): JiraLogin {
  const skillDir = join(homedir(), '.claude', 'skills', 'jira')
  const pythonPath = d.pythonPath ?? join(skillDir, '.venv', 'bin', 'python')
  const scriptPath = d.scriptPath ?? join(skillDir, 'jira_login.py')
  const spawn = d.spawn ?? defaultSpawn
  const timeoutMs = d.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let live: LoginProcess | null = null
  let running: Promise<JiraLoginResult> | null = null

  async function run(): Promise<JiraLoginResult> {
    try {
      await Promise.all([access(pythonPath), access(scriptPath)])
    } catch {
      return {
        ok: false,
        message: 'The jira skill is not installed (its login script or venv is missing).'
      }
    }

    return new Promise<JiraLoginResult>((resolve) => {
      let done = false
      let timer: NodeJS.Timeout | null = null
      const finish = (result: JiraLoginResult): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        live = null
        resolve(result)
      }

      let proc: LoginProcess
      try {
        proc = spawn(pythonPath, [scriptPath])
      } catch (err) {
        finish({ ok: false, message: err instanceof Error ? err.message : String(err) })
        return
      }
      live = proc
      proc.on('error', (err) => finish({ ok: false, message: err.message }))
      proc.on('exit', (code) =>
        finish(
          code === 0
            ? { ok: true }
            : { ok: false, message: 'The Jira login was not completed (window closed or timed out).' }
        )
      )
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* already dead */
        }
        finish({ ok: false, message: 'The Jira login timed out.' })
      }, timeoutMs)
    })
  }

  return {
    login() {
      if (!running) running = run().finally(() => (running = null))
      return running
    },

    dispose() {
      const current = live
      live = null
      if (!current) return
      try {
        current.kill()
      } catch {
        /* ignore */
      }
    }
  }
}
