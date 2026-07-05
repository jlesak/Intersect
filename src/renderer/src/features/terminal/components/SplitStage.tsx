import { useShallow } from 'zustand/react/shallow'
import type { Tab } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import { selectTabList, useTabsStore } from '@renderer/features/tabs'
import { TerminalPane } from './TerminalPane'

/** Arranges the workspace's terminals into the chosen split layout. Assumes at least one tab. */
export function SplitStage({ cwd }: { cwd: string }) {
  const layout = useTabsStore((s) => s.layout)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const assignToPane = useTabsStore((s) => s.assignToPane)
  const tabs = useTabsStore(useShallow(selectTabList))

  if (!workspaceId) return null

  const n = slotCount(layout)
  const paneTabs: (Tab | null)[] =
    layout === 'single'
      ? [tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null]
      : Array.from({ length: n }, (_, slot) => tabs.find((t) => t.paneSlot === slot) ?? null)

  const unplaced = tabs.filter((t) => t.paneSlot === null)

  return (
    <div className={`jv-stage jv-stage--${layout}`}>
      {paneTabs.map((tab, slot) => (
        <div key={slot} className={`jv-pane${tab ? '' : ' jv-pane--empty'}`}>
          {tab ? (
            <TerminalPane
              sessionId={makeSessionId(workspaceId, tab.id)}
              preset={tab.preset}
              cwd={cwd}
            />
          ) : (
            <EmptyPane unplaced={unplaced} onAssign={(id) => void assignToPane(id, slot)} />
          )}
        </div>
      ))}
    </div>
  )
}

function EmptyPane({ unplaced, onAssign }: { unplaced: Tab[]; onAssign: (id: string) => void }) {
  return (
    <>
      <span className="jv-eyebrow">Empty pane</span>
      {unplaced.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {unplaced.map((t) => (
            <button key={t.id} type="button" className="jv-btn jv-btn--ghost" onClick={() => onAssign(t.id)}>
              Place “{t.title}” here
            </button>
          ))}
        </div>
      ) : (
        <span style={{ color: 'var(--text-faint)' }}>Every tab is already placed</span>
      )}
    </>
  )
}
