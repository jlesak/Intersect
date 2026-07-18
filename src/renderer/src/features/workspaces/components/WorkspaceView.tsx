import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Preset } from '@common/domain'
import { selectTabList, TabBar, useTabsStore } from '@renderer/features/tabs'
import { SplitStage } from '@renderer/features/terminal'
import { IconClaude, IconShell } from '@renderer/shared/ui/icons'
import { selectSelectedWorkspace, useWorkspacesStore } from '../store'

/**
 * The terminal area of a project context: tab bar over the split stage. `projectScope` narrows it
 * to one project's workspaces (null = the Other bucket): a selection outside the scope renders as
 * empty instead of leaking another project's terminals; omit the prop for the unscoped area.
 */
export function WorkspaceView({ projectScope }: { projectScope?: string | null }) {
  let selected = useWorkspacesStore(selectSelectedWorkspace)
  if (selected && projectScope !== undefined && selected.projectId !== projectScope) {
    selected = undefined
  }
  const selectedId = selected?.id ?? null

  const tabsStatus = useTabsStore((s) => s.status)
  const layout = useTabsStore((s) => s.layout)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const tabs = useTabsStore(useShallow(selectTabList))

  // Load the selected workspace's terminal view whenever the selection changes.
  useEffect(() => {
    if (selectedId) void useTabsStore.getState().hydrate(selectedId)
    else useTabsStore.getState().clear()
  }, [selectedId])

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

  return (
    <>
      <TabBar />
      {ready && tabs.length === 0 ? (
        <NoTabs onOpen={(preset) => void useTabsStore.getState().createTab(preset)} />
      ) : (
        <SplitStage
          workspaceId={selected.id}
          cwd={selected.folderPath}
          projectKey={selected.projectId ?? 'other'}
          layout={layout}
          activeTabId={activeTabId}
          tabs={tabs}
          onAssign={(tabId, slot) => void useTabsStore.getState().assignToPane(tabId, slot)}
        />
      )}
    </>
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
