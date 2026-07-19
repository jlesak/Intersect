import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// A managed claude session is launched with INTERSECT_INSTANCE_ID in its environment, and
// that variable is inherited by ANY child claude the managed session spawns - subagents,
// skills, summarizers - which typically run from /private/tmp or another temp dir. Those
// nested sessions fire the same lifecycle hooks, and the bundled helper tags every POST
// with the inherited instance id. Routed naively, a nested session's SessionStart would
// overwrite the managed tab's resume id with a session that lives under a DIFFERENT
// project directory, so a later `claude --resume <id>` fails with "No session found".
//
// The discriminator is the working directory: the managed session always runs in the tab's
// own spawn cwd; every nested contaminator runs somewhere else.

/**
 * Canonicalize a path for comparison, resolving symlinks (/tmp -> /private/tmp on macOS).
 * Falls back to a trailing-slash-stripped string for paths that don't exist on disk.
 */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p.replace(/\/+$/, '')
  }
}

/**
 * True when a hook event's payload cwd belongs to the managed session, i.e. the event came
 * from the managed claude and not a nested child running elsewhere. A missing/empty hook
 * cwd cannot discriminate, so it is allowed through (every real Claude Code hook payload
 * carries a cwd; this is back-compat for ones that don't).
 */
export function hookCwdMatches(instanceCwd: string | undefined, hookCwd: unknown): boolean {
  if (!instanceCwd) return false
  if (typeof hookCwd !== 'string' || hookCwd === '') return true
  return canonicalize(instanceCwd) === canonicalize(hookCwd)
}

/**
 * Claude Code's per-project session directory: `~/.claude/projects/<slug>`, where `<slug>`
 * is the cwd with every non-alphanumeric character replaced by '-'.
 */
export function projectSessionDir(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  return path.join(homedir(), '.claude', 'projects', slug)
}

/** Whether Claude has a resumable transcript for `sessionId` under `cwd`'s project. */
export function sessionFileExists(cwd: string, sessionId: string): boolean {
  if (!sessionId) return false
  return fs.existsSync(path.join(projectSessionDir(cwd), `${sessionId}.jsonl`))
}

/**
 * Decide what to hand `claude --resume` for a suspended tab being reconciled at boot. Intersect only
 * ever resumes by the stored Claude session UUID (there is no `--session-id <rowId>` fallback), so
 * there is a single candidate: the stored id is used iff its transcript exists under the canonical
 * project-session dir for THIS cwd. A foreign/nested id inherited from another cwd has no transcript
 * under this project, so it resolves to null - the nested rejection is implicit - and the caller
 * treats null as "no safe resume target" (fresh spawn / recoverable failure). `exists` is injected
 * so the decision is unit-testable without touching the filesystem.
 */
export function resolveResumeTarget(
  cwd: string,
  resumeSessionId: string | null,
  exists: (cwd: string, sessionId: string) => boolean = sessionFileExists
): string | null {
  if (resumeSessionId && exists(cwd, resumeSessionId)) return resumeSessionId
  return null
}

/** A suspended claude tab as the boot reconcile sees it (the minimal shape it needs). */
export interface SuspendedTab {
  id: string
  workspaceId: string
  resumeSessionId: string | null
}

/**
 * The boot-time reconcile of suspended claude sessions: a pure DB+FS pass with no spawn, so it
 * terminates deterministically and can never enter a boot loop. Each suspended tab whose stored
 * resume id resolves to a real transcript under its workspace cwd is left `suspended` (the renderer
 * owns the actual respawn); anything else - a missing cwd, a missing/foreign transcript - degrades
 * to the recoverable `resume-failed` state. `exists` is injected for testing.
 */
export function reconcileSuspendedTabs(
  deps: {
    listSuspended(): SuspendedTab[]
    workspaceCwd(workspaceId: string): string | undefined
    setResumeFailed(tabId: string, reason: string): void
  },
  exists: (cwd: string, sessionId: string) => boolean = sessionFileExists
): void {
  for (const tab of deps.listSuspended()) {
    const cwd = deps.workspaceCwd(tab.workspaceId)
    const target = cwd ? resolveResumeTarget(cwd, tab.resumeSessionId, exists) : null
    if (!target) deps.setResumeFailed(tab.id, 'resume-failed')
  }
}
