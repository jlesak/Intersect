import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Preset } from '@common/domain'
import { selectTabList, TabBar, useTabsStore } from '@renderer/features/tabs'
import { SplitStage } from '@renderer/features/terminal'
import { IconClaude, IconShell } from '@renderer/shared/ui/icons'
import { selectSelectedWorkspace, useWorkspacesStore } from '../store'

/** The main content for the workspaces section: tab bar over the split stage. */
export function WorkspaceView() {
  const selected = useWorkspacesStore(selectSelectedWorkspace)
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
      <div className="ix-main">
        <div className="ix-empty">
          <span className="ix-eyebrow">No workspace</span>
          <div className="ix-empty__title">Nothing open</div>
          <p className="ix-empty__hint">Add a workspace from the sidebar to start opening terminals.</p>
        </div>
      </div>
    )
  }

  const ready = tabsStatus === 'ready' && workspaceId === selected.id

  return (
    <div className="ix-main">
      <TabBar />
      {ready && tabs.length === 0 ? (
        <NoTabs onOpen={(preset) => void useTabsStore.getState().createTab(preset)} />
      ) : (
        <SplitStage
          workspaceId={selected.id}
          cwd={selected.folderPath}
          layout={layout}
          activeTabId={activeTabId}
          tabs={tabs}
          onAssign={(tabId, slot) => void useTabsStore.getState().assignToPane(tabId, slot)}
        />
      )}
    </div>
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
