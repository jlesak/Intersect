import { useEffect } from 'react'
import { useTabsStore } from '@renderer/features/tabs'
import { installTerminalFindShortcut, SplitStage } from '@renderer/features/terminal'
import { selectSelectedWorkspace, useWorkspacesStore } from '../store'

/**
 * The terminal area of a project context: the split stage, each of whose panes carries its own
 * tab bar. `projectScope` narrows it to one project's workspaces (null = the Other bucket): a
 * selection outside the scope renders as empty instead of leaking another project's terminals;
 * omit the prop for the unscoped area.
 */
export function WorkspaceView({ projectScope }: { projectScope?: string | null }) {
  let selected = useWorkspacesStore(selectSelectedWorkspace)
  if (selected && projectScope !== undefined && selected.projectId !== projectScope) {
    selected = undefined
  }
  const selectedId = selected?.id ?? null

  const layout = useTabsStore((s) => s.layout)

  // Load the selected workspace's terminal view whenever the selection changes.
  useEffect(() => {
    if (selectedId) void useTabsStore.getState().hydrate(selectedId)
    else useTabsStore.getState().clear()
  }, [selectedId])

  // Find-in-scrollback is bound only while the terminal area is on screen, so the key can never
  // be taken away from an editor showing somewhere else in the app.
  useEffect(() => installTerminalFindShortcut(), [])

  if (!selected) {
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">No workspace</span>
        <div className="ix-empty__title">Nothing open</div>
        <p className="ix-empty__hint">Add a workspace from the sidebar to start opening terminals.</p>
      </div>
    )
  }

  // A workspace with nothing open is just its first group standing empty, so the stage renders it
  // like any other empty group: a tab bar with its "+" over the pane's own starter buttons. A
  // separate workspace-wide empty screen would take the tab bar away with it.
  return (
    <SplitStage
      workspaceId={selected.id}
      cwd={selected.folderPath}
      projectKey={selected.projectId ?? 'other'}
      layout={layout}
    />
  )
}
