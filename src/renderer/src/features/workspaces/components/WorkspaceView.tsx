import { useEffect } from 'react'
import type { Preset } from '@common/domain'
import { TabBar, useTabsStore } from '@renderer/features/tabs'
import { SplitStage } from '@renderer/features/terminal'
import { IconClaude, IconShell } from '@renderer/shared/ui/icons'
import { selectSelectedWorkspace, useWorkspacesStore } from '../store'

/** The main content for the workspaces section: tab bar over the split stage. */
export function WorkspaceView() {
  const selected = useWorkspacesStore(selectSelectedWorkspace)
  const selectedId = selected?.id ?? null
  const tabsStatus = useTabsStore((s) => s.status)
  const tabCount = useTabsStore((s) => s.order.length)

  // Load the selected workspace's terminal view whenever the selection changes.
  useEffect(() => {
    if (selectedId) void useTabsStore.getState().hydrate(selectedId)
    else useTabsStore.getState().clear()
  }, [selectedId])

  if (!selected) {
    return (
      <div className="jv-main">
        <div className="jv-empty">
          <span className="jv-eyebrow">No workspace</span>
          <div className="jv-empty__title">Nothing open</div>
          <p className="jv-empty__hint">Add a workspace from the sidebar to start opening terminals.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="jv-main">
      <TabBar />
      {tabsStatus === 'ready' && tabCount === 0 ? (
        <NoTabs onOpen={(preset) => void useTabsStore.getState().createTab(preset)} />
      ) : (
        <SplitStage cwd={selected.folderPath} />
      )}
    </div>
  )
}

function NoTabs({ onOpen }: { onOpen: (preset: Preset) => void }) {
  return (
    <div className="jv-empty">
      <span className="jv-eyebrow">No terminals</span>
      <div className="jv-empty__title">Open a terminal to get going</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="jv-btn jv-btn--primary" onClick={() => onOpen('shell')}>
          <IconShell /> Shell
        </button>
        <button type="button" className="jv-btn" onClick={() => onOpen('claude')}>
          <IconClaude /> Claude Code
        </button>
      </div>
    </div>
  )
}
