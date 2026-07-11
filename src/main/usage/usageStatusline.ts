import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Filename (relative to userData) the usage-statusline script is materialized under at boot. */
export const USAGE_STATUSLINE_SCRIPT_FILENAME = 'intersect-claude-usage-statusline.js'

/** Filename (relative to userData) the captured rate-limit snapshot is written to. */
export const USAGE_SNAPSHOT_FILENAME = 'claude-usage.json'

/**
 * Shell command Claude Code's `statusLine.command` runs. Invokes the app-managed statusline
 * script as plain Node (`ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as a `node`
 * executable instead of launching the app itself). Both paths are single-quoted since the
 * userData path can contain characters (spaces, `"`, `$`, backticks) that plain double quotes
 * would not survive.
 */
export function usageStatuslineCommand(execPath: string, scriptPath: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${singleQuote(execPath)} ${singleQuote(scriptPath)}`
}

/** POSIX single-quote a shell argument, safe for paths containing spaces or apostrophes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Picks `statusLine.command` out of a `~/.claude/settings*.json` file's content, or null if the
 * file is missing, malformed, or carries no statusline of its own. Never throws.
 */
export function extractUserStatuslineCommand(settingsJson: string): string | null {
  try {
    const parsed = JSON.parse(settingsJson)
    const command = parsed?.statusLine?.command
    return typeof command === 'string' && command.length > 0 ? command : null
  } catch {
    return null
  }
}

/**
 * Resolves the user's own statusline command across `~/.claude/settings.json` and
 * `~/.claude/settings.local.json`, mirroring Claude Code's own settings precedence: local
 * overrides shared/global, so a statusline configured only in settings.local.json is honored
 * instead of being silently dropped, and one configured in both defers to the local copy. Either
 * argument is null when the corresponding file could not be read.
 */
export function resolveUserStatuslineCommand(
  settingsJson: string | null,
  settingsLocalJson: string | null
): string | null {
  const local = settingsLocalJson !== null ? extractUserStatuslineCommand(settingsLocalJson) : null
  return local ?? (settingsJson !== null ? extractUserStatuslineCommand(settingsJson) : null)
}

/**
 * Source of the standalone, dependency-free CommonJS script materialized to userData and run as a
 * subprocess by Claude Code's own `statusLine.command` (never imported - it has no module graph
 * back into the app). Claude Code feeds it the same statusline JSON on stdin it would feed the
 * user's own statusline command (carrying `rate_limits` for Pro/Max subscribers); the script tees
 * that input two ways:
 *
 * 1. It picks out `rate_limits` (verbatim, whatever shape Claude Code sent - this script does not
 *    interpret its fields) and atomically writes `{ rateLimits, capturedAt }` to the app's usage
 *    snapshot file, for the sidebar's usage panel to read.
 * 2. If the user had their own `statusLine.command` configured (baked in at generation time), it
 *    forwards the same stdin to that command via the shell and echoes its stdout back out, so the
 *    user's own statusline keeps rendering inside Claude Code exactly as before.
 *
 * Must never crash or block Claude Code's rendering - every step is best-effort and swallows its
 * own errors; a missing/malformed `rate_limits` just means no usage snapshot, not a broken
 * statusline, and a failing forwarded command just means no forwarded output.
 */
export function buildUsageStatuslineScript(userDataDir: string, originalCommand: string | null): string {
  const snapshotPath = join(userDataDir, USAGE_SNAPSHOT_FILENAME)
  return `'use strict'

// Tees Claude Code's own statusline JSON (fed on stdin) into a local usage snapshot Intersect's
// sidebar reads, and forwards the same stdin to the user's own configured statusline command (if
// any) so its output keeps rendering inside Claude Code. Invoked by Claude Code as:
//   ELECTRON_RUN_AS_NODE=1 "<electron binary>" "<this file>"
// Never throws and never blocks the statusline - a missing/malformed 'rate_limits' just means no
// snapshot, and a failing forwarded command just means no forwarded output.

const fs = require('fs')
const { spawnSync } = require('child_process')

const SNAPSHOT_PATH = ${JSON.stringify(snapshotPath)}
const FORWARD_COMMAND = ${JSON.stringify(originalCommand)}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function extractRateLimits(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.rate_limits ? parsed.rate_limits : null
  } catch {
    return null
  }
}

function writeSnapshotAtomically(rateLimits) {
  try {
    const snapshot = JSON.stringify({ rateLimits: rateLimits, capturedAt: Date.now() })
    const tmpPath = SNAPSHOT_PATH + '.' + process.pid + '.' + Date.now() + '.tmp'
    fs.writeFileSync(tmpPath, snapshot)
    fs.renameSync(tmpPath, SNAPSHOT_PATH)
  } catch {
    // Best-effort: a snapshot write failure must never break the statusline.
  }
}

function forward(stdin) {
  if (!FORWARD_COMMAND) return
  try {
    const result = spawnSync(FORWARD_COMMAND, { shell: true, input: stdin, encoding: 'utf8' })
    if (result && result.stdout) process.stdout.write(result.stdout)
  } catch {
    // No forwarded output on failure; still exit cleanly.
  }
}

const stdin = readStdin()
writeSnapshotAtomically(extractRateLimits(stdin))
forward(stdin)
`
}

/** Writes buildUsageStatuslineScript(userDataDir, originalCommand) to `path`. */
export function writeUsageStatuslineScript(
  path: string,
  userDataDir: string,
  originalCommand: string | null
): void {
  writeFileSync(path, buildUsageStatuslineScript(userDataDir, originalCommand))
}
