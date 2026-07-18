import { writeFileSync } from 'node:fs'
import type { HookEventName } from '../hooks/hookListener'

/**
 * Shell command Claude Code's hooks run to report a lifecycle event to the app. Invokes the
 * bundled hook helper as plain Node (`ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave
 * as a `node` executable instead of launching the app itself), passing the support directory
 * (where the helper discovers the listener port and bearer token) and the event name. All
 * paths are single-quoted since the userData path can contain characters (spaces, `"`, `$`,
 * backticks) that plain double quotes would not survive.
 */
function hookCommand(
  execPath: string,
  helperPath: string,
  supportDir: string,
  event: HookEventName
): string {
  return `ELECTRON_RUN_AS_NODE=1 ${singleQuote(execPath)} ${singleQuote(helperPath)} ${singleQuote(supportDir)} ${event}`
}

/** POSIX single-quote a shell argument, safe for paths containing spaces or apostrophes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Claude Code `--settings` payload that wires the session's lifecycle hooks to the bundled
 * hook helper, which POSTs each event to the app's authenticated localhost listener (and,
 * for the events that double as PTY attention markers, still prints the legacy marker so
 * the detector fallback works when the listener is down). The wired events:
 * - `Notification` split by matcher: `permission_prompt` (Claude needs a tool-permission
 *   decision) and `idle_prompt` (Claude's own ~60s idle backstop).
 * - `Stop` fires at the end of every assistant turn - immediately, unlike `idle_prompt`'s
 *   timeout - so it is what actually drives the tab turning green promptly.
 * - `UserPromptSubmit` marks the turn start, `SessionStart` captures Claude's session UUID
 *   for resume, `SessionEnd` is recorded for diagnostics only, and `PreToolUse` feeds the
 *   permission-risk classifier. Turn-lifecycle events take no matcher (only tool-activity
 *   events have one).
 *
 * `statusLineCommand`, when given, additionally wires Claude Code's `statusLine.command` to the
 * app-managed usage-statusline script (see src/main/usage/usageStatusline.ts), so the sidebar's
 * usage panel gets a live snapshot of the user's rate-limit usage. Omitted entirely when no
 * command is given, so a boot-time failure to prepare the statusline script degrades to no
 * `statusLine` key rather than a broken one.
 */
export function buildNotifSettings(
  execPath: string,
  helperPath: string,
  supportDir: string,
  statusLineCommand?: string
): object {
  const command = (event: HookEventName): { type: string; command: string }[] => [
    { type: 'command', command: hookCommand(execPath, helperPath, supportDir, event) }
  ]
  return {
    hooks: {
      Notification: [
        { matcher: 'idle_prompt', hooks: command('NotificationIdle') },
        { matcher: 'permission_prompt', hooks: command('NotificationPermission') }
      ],
      Stop: [{ hooks: command('Stop') }],
      UserPromptSubmit: [{ hooks: command('UserPromptSubmit') }],
      SessionStart: [{ hooks: command('SessionStart') }],
      SessionEnd: [{ hooks: command('SessionEnd') }],
      PreToolUse: [{ hooks: command('PreToolUse') }]
    },
    ...(statusLineCommand ? { statusLine: { type: 'command', command: statusLineCommand } } : {})
  }
}

/**
 * Writes buildNotifSettings(execPath, helperPath, supportDir, statusLineCommand) as JSON to
 * `path`, for Claude Code to load via `--settings`.
 */
export function writeNotifSettings(
  path: string,
  execPath: string,
  helperPath: string,
  supportDir: string,
  statusLineCommand?: string
): void {
  writeFileSync(path, JSON.stringify(buildNotifSettings(execPath, helperPath, supportDir, statusLineCommand)))
}
