import { useEffect } from 'react'
import { Group, Panel, Separator, type Layout as PanelLayout } from 'react-resizable-panels'
import type { Layout, Tab } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import type { PairShares } from '@common/terminalLayoutShares'
import { useLayoutRatiosStore } from '../layoutRatios'
import { TerminalPane } from './TerminalPane'

export interface SplitStageProps {
  workspaceId: string
  cwd: string
  /** The project the workspace belongs to ('other' = the virtual bucket); keys the pane shares. */
  projectKey: string
  layout: Layout
  activeTabId: string | null
  tabs: Tab[]
  onAssign: (tabId: string, slot: number) => void
}

/** Every pane keeps at least this share of its group, so no terminal collapses to uselessness. */
const MIN_PANE_SIZE = '10%'

// The panel library defaults its content wrapper to overflow auto; terminals size themselves
// to the pane, so scrollbars must never appear around them.
const paneStyle = { overflow: 'hidden' } as const

/**
 * Arranges the workspace's terminals into the chosen split layout, with draggable pane
 * dividers whose shares persist per project and layout (through the terminal slice's own
 * ratio store). Pane content is fully controlled - it renders the tabs it is given.
 */
export function SplitStage({
  workspaceId,
  cwd,
  projectKey,
  layout,
  activeTabId,
  tabs,
  onAssign
}: SplitStageProps) {
  const loaded = useLayoutRatiosStore((s) => s.loaded && s.projectKey === projectKey)

  // The persisted shares must be in place before a resizable group mounts (the panel library
  // reads default sizes only at mount), so hydration starts with the project switch and the
  // groups render below only once it lands.
  useEffect(() => {
    void useLayoutRatiosStore.getState().hydrate(projectKey)
  }, [projectKey])

  // Leaving a layout or project must not drop a pending share write mid-debounce.
  useEffect(() => () => useLayoutRatiosStore.getState().flush(), [projectKey, layout])

  const n = slotCount(layout)
  const paneTabs: (Tab | null)[] =
    layout === 'single'
      ? [tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null]
      : Array.from({ length: n }, (_, slot) => tabs.find((t) => t.paneSlot === slot) ?? null)

  const unplaced = tabs.filter((t) => t.paneSlot === null)

  const paneClass = (slot: number): string => `ix-pane${paneTabs[slot] ? '' : ' ix-pane--empty'}`
  const paneContent = (slot: number): React.ReactNode => {
    const tab = paneTabs[slot]
    return tab ? (
      <TerminalPane
        sessionId={makeSessionId(workspaceId, tab.id)}
        preset={tab.preset}
        cwd={cwd}
        resumeSessionId={tab.resumeSessionId}
      />
    ) : (
      <EmptyPane unplaced={unplaced} onAssign={(id) => onAssign(id, slot)} />
    )
  }

  // Single has nothing to resize; before hydration the equal-share static grid avoids
  // mounting groups with defaults that would be wrong a moment later.
  if (layout === 'single' || !loaded) {
    return (
      <div className={`ix-stage ix-stage--${layout}`}>
        {paneTabs.map((_, slot) => (
          <div key={slot} className={paneClass(slot)}>
            {paneContent(slot)}
          </div>
        ))}
      </div>
    )
  }

  if (layout === 'grid') return <GridStage paneClass={paneClass} paneContent={paneContent} />
  return <PairStage layout={layout} paneClass={paneClass} paneContent={paneContent} />
}

interface StagePaneProps {
  paneClass: (slot: number) => string
  paneContent: (slot: number) => React.ReactNode
}

const pairOf = (l: PanelLayout, first: string, second: string): PairShares => [l[first], l[second]]

/** Columns/rows: one two-pane group split along the layout's axis. */
function PairStage({
  layout,
  paneClass,
  paneContent
}: StagePaneProps & { layout: 'columns' | 'rows' }) {
  const shares = useLayoutRatiosStore((s) => s[layout])
  const store = useLayoutRatiosStore.getState
  const toPair = (l: PanelLayout): PairShares => pairOf(l, 'slot-0', 'slot-1')
  return (
    <Group
      key={layout}
      orientation={layout === 'columns' ? 'horizontal' : 'vertical'}
      className={`ix-stage ix-stage--${layout} ix-stage--resizable`}
      onLayoutChange={(l) => store().preview(layout, toPair(l))}
      onLayoutChanged={(l, meta) => meta.isUserInteraction && store().commit(layout, toPair(l))}
      defaultLayout={{ 'slot-0': shares[0], 'slot-1': shares[1] }}
    >
      <Panel id="slot-0" minSize={MIN_PANE_SIZE} className={paneClass(0)} style={paneStyle}>
        {paneContent(0)}
      </Panel>
      <Separator className="ix-stage__sep" />
      <Panel id="slot-1" minSize={MIN_PANE_SIZE} className={paneClass(1)} style={paneStyle}>
        {paneContent(1)}
      </Panel>
    </Group>
  )
}

/**
 * Grid: one column split shared by both rows (a single full-height divider), plus an
 * independent row split per column half - see GridShares. Slots keep their positions from
 * the static grid: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right.
 */
function GridStage({ paneClass, paneContent }: StagePaneProps) {
  const grid = useLayoutRatiosStore((s) => s.grid)
  const store = useLayoutRatiosStore.getState
  const update =
    (axis: 'columns' | 'leftRows' | 'rightRows', first: string, second: string) =>
    (l: PanelLayout, commit: boolean) => {
      const next = { ...store().grid, [axis]: pairOf(l, first, second) }
      if (commit) store().commit('grid', next)
      else store().preview('grid', next)
    }
  const onColumns = update('columns', 'left', 'right')
  const onLeftRows = update('leftRows', 'slot-0', 'slot-2')
  const onRightRows = update('rightRows', 'slot-1', 'slot-3')

  const half = (
    id: 'left' | 'right',
    rows: PairShares,
    onRows: (l: PanelLayout, commit: boolean) => void,
    topSlot: number,
    bottomSlot: number
  ): React.ReactNode => (
    <Panel key={id} id={id} minSize={MIN_PANE_SIZE} style={paneStyle}>
      <Group
        orientation="vertical"
        className="ix-stage__half"
        onLayoutChange={(l) => onRows(l, false)}
        onLayoutChanged={(l, meta) => meta.isUserInteraction && onRows(l, true)}
        defaultLayout={{ [`slot-${topSlot}`]: rows[0], [`slot-${bottomSlot}`]: rows[1] }}
      >
        <Panel
          id={`slot-${topSlot}`}
          minSize={MIN_PANE_SIZE}
          className={paneClass(topSlot)}
          style={paneStyle}
        >
          {paneContent(topSlot)}
        </Panel>
        <Separator className="ix-stage__sep" />
        <Panel
          id={`slot-${bottomSlot}`}
          minSize={MIN_PANE_SIZE}
          className={paneClass(bottomSlot)}
          style={paneStyle}
        >
          {paneContent(bottomSlot)}
        </Panel>
      </Group>
    </Panel>
  )

  return (
    <Group
      orientation="horizontal"
      className="ix-stage ix-stage--grid ix-stage--resizable"
      onLayoutChange={(l) => onColumns(l, false)}
      onLayoutChanged={(l, meta) => meta.isUserInteraction && onColumns(l, true)}
      defaultLayout={{ left: grid.columns[0], right: grid.columns[1] }}
    >
      {half('left', grid.leftRows, onLeftRows, 0, 2)}
      <Separator className="ix-stage__sep" />
      {half('right', grid.rightRows, onRightRows, 1, 3)}
    </Group>
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
