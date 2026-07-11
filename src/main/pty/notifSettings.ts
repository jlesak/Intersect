import { writeFileSync } from 'node:fs'
import { IDLE_TOKEN, PERMISSION_TOKEN, STOP_TOKEN, type AttentionKind } from './attentionMarkers'

/** Filename (relative to userData) the hook script is materialized under at boot. */
export const HOOK_SCRIPT_FILENAME = 'intersect-claude-notif-hook.js'

/**
 * Shell command Claude Code's hooks run to emit an attention marker into the PTY stream. Invokes
 * the app-managed hook script as plain Node (`ELECTRON_RUN_AS_NODE=1` makes the Electron binary
 * behave as a `node` executable instead of launching the app itself), passing the kind so the
 * script knows which token to print. Both paths are single-quoted since the userData path can
 * contain characters (spaces, `"`, `$`, backticks) that plain double quotes would not survive.
 */
function hookCommand(execPath: string, scriptPath: string, kind: AttentionKind): string {
  return `ELECTRON_RUN_AS_NODE=1 ${singleQuote(execPath)} ${singleQuote(scriptPath)} ${kind}`
}

/** POSIX single-quote a shell argument, safe for paths containing spaces or apostrophes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Source of the standalone, dependency-free CommonJS script materialized to userData and run as a
 * subprocess by Claude Code's hooks (never imported - it has no module graph back into the app).
 * It reads the hook's JSON input from stdin to recover Claude's own `.message` when the hook
 * carries one (Notification hooks do; Stop hooks never do), base64-encodes it so it survives
 * intact as a single OSC 9 field, and writes Claude Code's own `{"terminalSequence": ...}`
 * hook-output contract to stdout so the sequence reaches the PTY. It must never crash on
 * missing/malformed stdin - that just means no message, not a broken marker.
 */
export function buildHookScript(): string {
  return `'use strict'

// Emits an app-private OSC 9 attention marker into Intersect's PTY output stream. Invoked by a
// Claude Code hook (Notification for idle/permission, Stop for turn end) as:
//   ELECTRON_RUN_AS_NODE=1 "<electron binary>" "<this file>" <kind>
// Reads the hook's JSON input from stdin to recover Claude's own \`.message\` when present
// (Notification hooks carry one; Stop hooks never do), and writes Claude Code's own
// \`{"terminalSequence": ...}\` hook-output contract to stdout so the sequence reaches the PTY.
// Never throws on missing/invalid stdin - that just means no message, not a broken marker.

const ESC = '\\u001b'
const BEL = '\\u0007'

const TOKEN_BY_KIND = {
  idle: '${IDLE_TOKEN}',
  permission: '${PERMISSION_TOKEN}',
  stop: '${STOP_TOKEN}'
}

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function extractMessage(raw) {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : undefined
  } catch {
    return undefined
  }
}

const kind = process.argv[2]
const token = TOKEN_BY_KIND[kind]
if (token) {
  const message = extractMessage(readStdin())
  const payload = message ? ';' + Buffer.from(message, 'utf8').toString('base64') : ''
  const sequence = ESC + ']9;' + token + payload + BEL
  process.stdout.write(JSON.stringify({ terminalSequence: sequence }))
}
`
}

/** Writes buildHookScript() to `path`, for the injected settings' hooks to invoke. */
export function writeNotifHookScript(path: string): void {
  writeFileSync(path, buildHookScript())
}

/**
 * Claude Code `--settings` payload that wires the idle prompt, permission prompt, and end-of-turn
 * Stop event to the hook script, letting the main process detect them in the PTY output stream.
 * `Stop` fires at the end of every assistant turn - immediately, unlike `idle_prompt`'s ~60s
 * timeout - so it is what actually drives the tab turning green promptly; `idle_prompt` remains
 * wired as a backstop for the rare case a turn ends without a Stop event. `Stop` takes no matcher
 * (Claude Code hook events tied to tool activity have one; turn-lifecycle events like Stop do not).
 *
 * `statusLineCommand`, when given, additionally wires Claude Code's `statusLine.command` to the
 * app-managed usage-statusline script (see src/main/usage/usageStatusline.ts), so the sidebar's
 * usage panel gets a live snapshot of the user's rate-limit usage. Omitted entirely when no
 * command is given, so a boot-time failure to prepare the statusline script degrades to no
 * `statusLine` key rather than a broken one.
 */
export function buildNotifSettings(
  execPath: string,
  scriptPath: string,
  statusLineCommand?: string
): object {
  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: hookCommand(execPath, scriptPath, 'idle') }]
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: hookCommand(execPath, scriptPath, 'permission') }]
        }
      ],
      Stop: [{ hooks: [{ type: 'command', command: hookCommand(execPath, scriptPath, 'stop') }] }]
    },
    ...(statusLineCommand ? { statusLine: { type: 'command', command: statusLineCommand } } : {})
  }
}

/**
 * Writes buildNotifSettings(execPath, scriptPath, statusLineCommand) as JSON to `path`, for
 * Claude Code to load via `--settings`.
 */
export function writeNotifSettings(
  path: string,
  execPath: string,
  scriptPath: string,
  statusLineCommand?: string
): void {
  writeFileSync(path, JSON.stringify(buildNotifSettings(execPath, scriptPath, statusLineCommand)))
}
