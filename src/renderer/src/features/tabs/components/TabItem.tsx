import type { DragEvent, MouseEvent } from 'react'
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
      // Renaming turns the tab into a text field, and a draggable ancestor takes the pointer away
      // from selecting inside it, so the drag is off for exactly as long as the input is up.
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={() => !renaming && onActivate()}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
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
      >
        <IconClose width={12} height={12} />
      </button>
    </div>
  )
}
