import type { PermissionRisk } from '@common/ipc'

/** The tool call captured from the session's most recent cwd-valid PreToolUse hook. */
export interface PendingToolUse {
  toolName: string
  toolInput: unknown
}

/** Tools that only read - a permission request for these is never destructive. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
  'TodoRead'
])

/**
 * Shell command shapes that can destroy data or escalate privileges. Matched against the
 * Bash tool's command string (and, as a fallback, the permission message, which usually
 * embeds the command). Patterns favor precision over recall - a miss degrades to
 * 'unknown', never to 'ordinary'.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s/, // rm -rf / rm -fr / rm -r -f
  /\bsudo\b/,
  /\bgit\s+push\s+[^|;&]*(--force\b|-f\b|--force-with-lease\b)/,
  /\bgit\s+reset\s+[^|;&]*--hard\b/,
  /\bgit\s+clean\s+[^|;&]*-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+[^|;&]*--force\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b(?![^;]*\bwhere\b)/i,
  /\bmkfs\b/,
  /\bdd\s+[^|;&]*of=\/dev\//,
  />\s*\/dev\/(sd|disk|nvme)/,
  /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\b/,
  /\bchown\s+-[a-zA-Z]*R\b/,
  /\bkill(all)?\s+-9\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // classic fork bomb
  /\bshutdown\b|\breboot\b/,
  /\blaunchctl\s+(unload|remove)\b/,
  /\bnpm\s+publish\b/,
  /\bcurl\s+[^|;&]*\|\s*(ba)?sh\b/ // pipe-to-shell installers
]

function isDangerousText(text: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(text))
}

/** Best-effort extraction of the Bash tool's command string from a PreToolUse tool_input. */
function commandOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const command = (toolInput as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/**
 * Classify a permission request from what the session was about to do. Prefers the captured
 * PreToolUse tool call (name + input) because it is structured; falls back to scanning
 * Claude's own permission message, which usually quotes the command. Read-only tools are
 * 'ordinary'; a Bash command matching a destructive pattern is 'dangerous'; everything the
 * classifier cannot positively vouch for stays 'unknown'.
 */
export function classifyPermissionRisk(
  message: string | undefined,
  pendingToolUse: PendingToolUse | undefined
): PermissionRisk {
  if (pendingToolUse) {
    if (READ_ONLY_TOOLS.has(pendingToolUse.toolName)) return 'ordinary'
    if (pendingToolUse.toolName === 'Bash') {
      const command = commandOf(pendingToolUse.toolInput)
      if (command && isDangerousText(command)) return 'dangerous'
      return 'unknown'
    }
  }
  if (message && isDangerousText(message)) return 'dangerous'
  return 'unknown'
}
