import { sep } from 'node:path'
import type { Tab, Workspace } from '@common/domain'

/** Counts only live PTYs whose canonical workspace folder belongs to the main checkout. */
export function gitSessionWarning(
  mainPath: string,
  workspaces: Workspace[],
  tabsForWorkspace: (id: string) => Tab[],
  hasSession: (id: string) => boolean,
  canonicalize: (path: string) => string,
  linkedWorktreeParent: (path: string) => string | null
): { claudeSessions: number; terminalSessions: number } {
  let claudeSessions = 0
  let terminalSessions = 0
  for (const workspace of workspaces) {
    const folder = canonicalize(workspace.folderPath)
    if (folder !== mainPath && !folder.startsWith(mainPath + sep)) continue
    if (linkedWorktreeParent(folder)) continue
    for (const tab of tabsForWorkspace(workspace.id)) {
      if (!hasSession(`${workspace.id}:${tab.id}`)) continue
      if (tab.preset === 'claude') claudeSessions++
      else terminalSessions++
    }
  }
  return { claudeSessions, terminalSessions }
}
