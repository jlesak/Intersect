import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PRESET_META, type WorkItemRef } from '@common/domain'
import { makeSessionId, type SessionStatus } from '@common/ipc'
import { slotCount } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconPencil,
  IconTrash
} from '@renderer/shared/ui/icons'
import { selectTabList, useTabsStore } from '../store'
import { LayoutPicker } from './LayoutPicker'
import { PresetPicker } from './PresetPicker'

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

export function TabBar() {
  const tabs = useTabsStore(useShallow(selectTabList))
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const layout = useTabsStore((s) => s.layout)
  const presetPickerOpen = useTabsStore((s) => s.presetPickerOpen)
  const attention = useAttentionStore((s) => s.status)
  const workItems = useWorkItemsStore((s) => s.byTabId)
  const store = useTabsStore.getState()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null)
  const overflowRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  // The popover is the only thing that reads this flag, and the shortcut can raise it while no tab
  // bar is on screen at all. Dropping it on unmount stops the popover appearing unbidden the next
  // time the user returns to a terminal.
  useEffect(() => () => useTabsStore.getState().setPresetPickerOpen(false), [])

  /** Scroll the strip to a tab, which matters once the tabs outgrow the room the strip has. */
  const revealTab = (id: string): void => {
    tabRefs.current.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // Activation reaches the bar from a click, an accelerator, the palette and the overflow list
  // alike, and a tab the user switched to is no use while it sits off the end of the strip.
  useEffect(() => {
    if (activeTabId) revealTab(activeTabId)
  }, [activeTabId])

  const statusOf = (tabId: string): SessionStatus | undefined =>
    workspaceId ? attention[makeSessionId(workspaceId, tabId)]?.status : undefined

  const move = (id: string, dir: -1 | 1): void => {
    const ids = tabs.map((t) => t.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void store.reorderTabs(ids)
  }

  const startRename = (id: string, title: string): void => {
    setRenamingId(id)
    setRenameValue(title)
  }
  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) void store.renameTab(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  const menuEntries = (id: string): MenuEntry[] => {
    const i = tabs.findIndex((t) => t.id === id)
    const hasWorkItem = workItems[id] !== undefined
    const entries: MenuEntry[] = [
      { label: 'Rename', icon: <IconPencil />, onClick: () => startRename(id, tabs[i].title) },
      { label: 'Move left', icon: <IconChevronLeft />, disabled: i <= 0, onClick: () => move(id, -1) },
      {
        label: 'Move right',
        icon: <IconChevronRight />,
        disabled: i >= tabs.length - 1,
        onClick: () => move(id, 1)
      },
      { separator: true },
      {
        label: hasWorkItem ? 'Change work item…' : 'Set work item…',
        onClick: () => useWorkItemsStore.getState().openPicker(id)
      }
    ]
    if (hasWorkItem) {
      entries.push({
        label: 'Clear work item',
        onClick: () => void useWorkItemsStore.getState().clearPrimary(id)
      })
    }
    if (layout !== 'single') {
      entries.push({ separator: true })
      for (let slot = 0; slot < slotCount(layout); slot++) {
        entries.push({
          label: `Open in pane ${slot + 1}`,
          onClick: () => void store.assignToPane(id, slot)
        })
      }
    }
    entries.push({ separator: true })
    entries.push({ label: 'Close tab', icon: <IconTrash />, danger: true, onClick: () => void store.removeTab(id) })
    return entries
  }

  /**
   * Every open tab with its preset badge and its session's attention state, so a tab the strip has
   * no room for can still be found and its state read.
   */
  const overflowEntries = (): MenuEntry[] =>
    tabs.map((tab) => {
      const status = statusOf(tab.id)
      return {
        label: tab.title,
        icon: (
          <span className="ix-tabmenu__mark">
            <span className="ix-tab__preset">{PRESET_META[tab.preset].badge}</span>
            {status && <span className={`ix-tabmenu__dot ix-tabmenu__dot--${status}`} />}
          </span>
        ),
        onClick: () => {
          void store.setActiveTab(tab.id)
          // Not left to the reveal effect: picking the tab that is already active changes nothing
          // for the effect to react to, and the user still asked to be shown that tab.
          revealTab(tab.id)
        }
      }
    })

  return (
    <div className="ix-tabbar">
      <div className="ix-tabs">
        {tabs.map((tab) => {
          const status = statusOf(tab.id)
          return (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el)
              else tabRefs.current.delete(tab.id)
            }}
            className={`ix-tab${tab.id === activeTabId ? ' ix-tab--active' : ''}${status ? ` ix-tab--${status}` : ''}`}
            onMouseDown={() => renamingId !== tab.id && void store.setActiveTab(tab.id)}
            onDoubleClick={() => startRename(tab.id, tab.title)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: tab.id })
            }}
          >
            <span className="ix-tab__preset">{PRESET_META[tab.preset].badge}</span>
            {workItems[tab.id] && <WorkItemChip workItem={workItems[tab.id]} />}
            {renamingId === tab.id ? (
              <input
                className="ix-tab__rename"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenamingId(null)
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
                void store.removeTab(tab.id)
              }}
            >
              <IconClose width={12} height={12} />
            </button>
          </div>
          )
        })}
        <PresetPicker
          open={presetPickerOpen}
          onOpenChange={store.setPresetPickerOpen}
          onPick={(preset) => void store.createTab(preset)}
        />
      </div>
      <div className="ix-tabbar__tools">
        <button
          ref={overflowRef}
          type="button"
          className="ix-iconbtn ix-tabbar__overflow"
          title="All tabs"
          aria-label="All tabs"
          onClick={() => {
            if (overflowAt) {
              setOverflowAt(null)
              return
            }
            const r = overflowRef.current?.getBoundingClientRect()
            setOverflowAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 })
          }}
        >
          <IconChevronDown />
        </button>
        <LayoutPicker layout={layout} onChange={(l) => void store.setLayout(l)} />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.id)} onClose={() => setMenu(null)} />
      )}
      {overflowAt && (
        <ContextMenu
          x={overflowAt.x}
          y={overflowAt.y}
          entries={overflowEntries()}
          anchor={overflowRef.current}
          onClose={() => setOverflowAt(null)}
        />
      )}
    </div>
  )
}
