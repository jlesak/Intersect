import { writeFileSync } from 'node:fs'
import { IDLE_TOKEN, PERMISSION_TOKEN } from './attentionMarkers'

// JSON unicode escapes for ESC and BEL, written as literal backslash-u text (not raw
// control bytes), used in the OSC 9 sequence (ESC ] 9 ; <payload> BEL) that attentionDetector
// scans for. Escaping them keeps the printf'd payload strictly valid JSON; Claude Code's own
// JSON parser unescapes them back into the real ESC/BEL bytes before writing terminalSequence
// to the PTY.
const ESC_ESCAPE = '\\u001b'
const BEL_ESCAPE = '\\u0007'

/**
 * Shell command Claude Code's Notification hook runs to emit a marker into the PTY stream.
 * Uses `printf '%s'` (no `jq` dependency) to print a JSON object whose `terminalSequence`
 * is the OSC 9 escape carrying the given marker, exactly as the app's PTY reader expects.
 */
function notificationCommand(token: string): string {
  return `printf '%s' '{"terminalSequence":"${ESC_ESCAPE}]9;${token}${BEL_ESCAPE}"}'`
}

/**
 * Claude Code `--settings` payload that wires the idle and permission prompts to print the
 * app-private attention markers, letting the main process detect them in the PTY output stream.
 */
export function buildNotifSettings(): object {
  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: notificationCommand(IDLE_TOKEN) }]
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: notificationCommand(PERMISSION_TOKEN) }]
        }
      ]
    }
  }
}

/** Writes buildNotifSettings() as JSON to `path`, for Claude Code to load via `--settings`. */
export function writeNotifSettings(path: string): void {
  writeFileSync(path, JSON.stringify(buildNotifSettings()))
}
