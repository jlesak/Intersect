import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { PRESET_META, type Tab, type WorkItemRef } from '@common/domain'
import type { SessionStatus } from '@common/ipc'
import { IconClose } from '@renderer/shared/ui/icons'

/**
 * The tab's work-item chip: the snapshot key with the full title on hover, dimmed/struck when
 * the remote item is stale or missing (the stored snapshot keeps rendering either way).
 */
export function WorkItemChip({ workItem }: { workItem: WorkItemRef }) {
  return (
    <span
      className={`ix-tab__workitem${
        workItem.state !== 'linked' ? ` ix-tab__workitem--${workItem.state}` : ''
      }`}
      title={`${workItem.snapshot.title}${workItem.state !== 'linked' ? ` (${workItem.state})` : ''}`}
    >
      {workItem.snapshot.key}
    </span>
  )
}

export interface TabItemProps {
  tab: Tab
  /** Whether this is the tab its group currently shows. */
  active: boolean
  /** This tab's 1-based place in its own bar, and how many tabs that bar holds. */
  position: number
  total: number
  /** The Claude session state of this tab's terminal, which colours the tab. */
  status?: SessionStatus
  workItem?: WorkItemRef
  renaming: boolean
  renameValue: string
  /** Registers the rendered element, so the bar can measure it and scroll it into view. */
  itemRef: (el: HTMLDivElement | null) => void
  onActivate: () => void
  onStartRename: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onClose: () => void
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void
  /** The bar's keyboard handling: activation, walking the strip, and moving the tab along it. */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  /** Whether this tab is the one currently being dragged, so it can fade out of its own strip. */
  dragging: boolean
}

/**
 * One tab in a group's strip: preset badge, work-item chip, title or its rename input, and the
 * close button. Purely presentational so the same markup serves every group, with the bar owning
 * which tab is being renamed and which is being dragged.
 */
export function TabItem({
  tab,
  active,
  position,
  total,
  status,
  workItem,
  renaming,
  renameValue,
  itemRef,
  onActivate,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onClose,
  onContextMenu,
  onKeyDown,
  onDragStart,
  onDragEnd,
  dragging
}: TabItemProps) {
  return (
    <div
      ref={itemRef}
      className={`ix-tab${active ? ' ix-tab--active' : ''}${status ? ` ix-tab--${status}` : ''}${
        dragging ? ' ix-tab--dragging' : ''
      }`}
      // Mirrors the session id the pane host carries, so which tab names which terminal is
      // readable from the DOM alone.
      data-tab-id={tab.id}
      role="tab"
      aria-selected={active}
      aria-posinset={position}
      aria-setsize={total}
      aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
      // One stop per bar rather than one per tab: the strip is entered on the tab its pane is
      // showing, and the arrow keys walk the rest of it from there.
      tabIndex={active ? 0 : -1}
      // Renaming turns the tab into a text field, and a draggable ancestor takes the pointer away
      // from selecting inside it, so the drag is off for exactly as long as the input is up.
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={() => !renaming && onActivate()}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      // While the input is up every key belongs to it, arrows and Enter included.
      onKeyDown={renaming ? undefined : onKeyDown}
    >
      <span className="ix-tab__preset">{PRESET_META[tab.preset].badge}</span>
      {workItem && <WorkItemChip workItem={workItem} />}
      {renaming ? (
        <input
          className="ix-tab__rename"
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="ix-tab__title">{tab.title}</span>
      )}
      <button
        type="button"
        className="ix-tab__close"
        aria-label={`Close ${tab.title}`}
        onMouseDown={(e) => {
          e.stopPropagation()
          onClose()
        }}
        // A button closes on Enter and Space of its own accord only through a click, which this
        // one never takes. Stopping the key here also keeps the tab underneath from reading the
        // same press as "activate me".
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
      >
        <IconClose width={12} height={12} />
      </button>
    </div>
  )
}
