import type { Layout, Tab } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import { TerminalPane } from './TerminalPane'

export interface SplitStageProps {
  workspaceId: string
  cwd: string
  layout: Layout
  activeTabId: string | null
  tabs: Tab[]
  onAssign: (tabId: string, slot: number) => void
}

/**
 * Arranges the workspace's terminals into the chosen split layout. Fully controlled - it renders
 * the state it is given and never reaches into a feature store, so the terminal slice depends on
 * no other slice.
 */
export function SplitStage({ workspaceId, cwd, layout, activeTabId, tabs, onAssign }: SplitStageProps) {
  const n = slotCount(layout)
  const paneTabs: (Tab | null)[] =
    layout === 'single'
      ? [tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null]
      : Array.from({ length: n }, (_, slot) => tabs.find((t) => t.paneSlot === slot) ?? null)

  const unplaced = tabs.filter((t) => t.paneSlot === null)

  return (
    <div className={`ix-stage ix-stage--${layout}`}>
      {paneTabs.map((tab, slot) => (
        <div key={slot} className={`ix-pane${tab ? '' : ' ix-pane--empty'}`}>
          {tab ? (
            <TerminalPane
              sessionId={makeSessionId(workspaceId, tab.id)}
              preset={tab.preset}
              cwd={cwd}
              resumeSessionId={tab.resumeSessionId}
            />
          ) : (
            <EmptyPane unplaced={unplaced} onAssign={(id) => onAssign(id, slot)} />
          )}
        </div>
      ))}
    </div>
  )
}

function EmptyPane({ unplaced, onAssign }: { unplaced: Tab[]; onAssign: (id: string) => void }) {
  return (
    <>
      <span className="ix-eyebrow">Empty pane</span>
      {unplaced.length > 0 ? (
        <div className="ix-col" style={{ gap: 6 }}>
          {unplaced.map((t) => (
            <button key={t.id} type="button" className="ix-btn ix-btn--ghost" onClick={() => onAssign(t.id)}>
              Place “{t.title}” here
            </button>
          ))}
        </div>
      ) : (
        <span className="ix-faint">Every tab is already placed</span>
      )}
    </>
  )
}
