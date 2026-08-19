import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Preset } from '@common/domain'
import { selectTabList, useTabsStore } from '@renderer/features/tabs'
import { installTerminalFindShortcut, SplitStage } from '@renderer/features/terminal'
import { IconClaude, IconShell } from '@renderer/shared/ui/icons'
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

  const tabsStatus = useTabsStore((s) => s.status)
  const layout = useTabsStore((s) => s.layout)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const tabs = useTabsStore(useShallow(selectTabList))

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

  const ready = tabsStatus === 'ready' && workspaceId === selected.id

  // Every tab now lives in a group, so the only workspace-wide empty state left is a workspace
  // with nothing open at all; anything less is a pane's own empty state, under its own tab bar.
  if (ready && tabs.length === 0) {
    return <NoTabs onOpen={(preset) => void useTabsStore.getState().createTab(preset)} />
  }

  return (
    <SplitStage
      workspaceId={selected.id}
      cwd={selected.folderPath}
      projectKey={selected.projectId ?? 'other'}
      layout={layout}
    />
  )
}

function NoTabs({ onOpen }: { onOpen: (preset: Preset) => void }) {
  return (
    <div className="ix-empty">
      <span className="ix-eyebrow">No terminals</span>
      <div className="ix-empty__title">Open a terminal to get going</div>
      <div className="ix-row" style={{ gap: 10 }}>
        <button type="button" className="ix-btn ix-btn--primary" onClick={() => onOpen('shell')}>
          <IconShell /> Shell
        </button>
        <button type="button" className="ix-btn" onClick={() => onOpen('claude')}>
          <IconClaude /> Claude Code
        </button>
      </div>
    </div>
  )
}
