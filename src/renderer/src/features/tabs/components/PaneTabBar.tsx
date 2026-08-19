import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PRESET_META, type Preset } from '@common/domain'
import { makeSessionId, type SessionStatus } from '@common/ipc'
import { slotCount, toolsSlot } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconTrash
} from '@renderer/shared/ui/icons'
import {
  selectFocusedSlot,
  selectGroupTabs,
  selectTabList,
  useTabsStore
} from '../store'
import { LayoutPicker } from './LayoutPicker'
import { PresetPicker } from './PresetPicker'
import { TabItem } from './TabItem'
import { dropIndexAt, dropTargetIndex, isTabDrag, readTabDrag, writeTabDrag } from './tabDrag'

/**
 * Open a new terminal directly into one group. `createTab` lands the tab in the focused group,
 * which is the right answer for the keyboard and the wrong one for a "+" pressed in another
 * group's bar or for an empty pane's starter buttons, so those move it home afterwards.
 */
export async function openTabInGroup(slot: number, preset: Preset): Promise<void> {
  const tab = await useTabsStore.getState().createTab(preset)
  if (!tab || tab.paneSlot === slot) return
  const settled = selectGroupTabs(useTabsStore.getState(), slot).filter((t) => t.id !== tab.id)
  await useTabsStore.getState().moveTab(tab.id, slot, settled.length)
}

/**
 * One tab group's strip, sitting inside the pane it names. It shows only its own group's tabs, and
 * the group that carries the workspace tools also ends its strip with the all-tabs overflow and
 * the layout picker, so those stay in the stage's top-right corner whatever the split.
 */
export function PaneTabBar({ slot }: { slot: number }) {
  const tabs = useTabsStore(useShallow((s) => selectGroupTabs(s, slot)))
  const allTabs = useTabsStore(useShallow(selectTabList))
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const layout = useTabsStore((s) => s.layout)
  const focusedSlot = useTabsStore(selectFocusedSlot)
  const presetPickerOpen = useTabsStore((s) => s.presetPickerOpen)
  const attention = useAttentionStore((s) => s.status)
  const workItems = useWorkItemsStore((s) => s.byTabId)
  const store = useTabsStore.getState()

  const focused = slot === focusedSlot
  // Marking the focused group only earns its keep once there is another group to tell it from.
  const marksFocus = focused && layout !== 'single'
  const carriesTools = slot === toolsSlot(layout)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [clickedPicker, setClickedPicker] = useState(false)
  const overflowRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  // The picker flag on the store is what the keyboard shortcut raises, and the shortcut means "in
  // the group I am working in". A "+" clicked in some other group's bar has to open that bar's
  // popover instead, which is what the local flag is for.
  const pickerOpen = clickedPicker || (focused && presetPickerOpen)
  const setPickerOpen = (open: boolean): void => {
    setClickedPicker(open)
    if (!open && focused) store.setPresetPickerOpen(false)
  }

  // The shortcut can raise the flag while this group is not on screen at all, and it survives
  // focus moving elsewhere. Dropping it as focus leaves stops the popover appearing unbidden the
  // next time the user comes back to this group.
  useEffect(() => {
    if (!focused) return
    return () => useTabsStore.getState().setPresetPickerOpen(false)
  }, [focused])

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
      {
        label: 'Move left',
        icon: <IconChevronLeft />,
        disabled: i <= 0,
        onClick: () => void store.moveTab(id, slot, i - 1)
      },
      {
        label: 'Move right',
        icon: <IconChevronRight />,
        disabled: i >= tabs.length - 1,
        onClick: () => void store.moveTab(id, slot, i + 1)
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
      for (let target = 0; target < slotCount(layout); target++) {
        const to = target
        entries.push({
          label: `Open in pane ${to + 1}`,
          disabled: to === slot,
          // Appending is the only placement a menu entry can mean, and the group's length has to
          // be read when the entry fires rather than when the menu was built.
          onClick: () => {
            const size = selectGroupTabs(useTabsStore.getState(), to).length
            void store.moveTab(id, to, size)
          }
        })
      }
    }
    entries.push({ separator: true })
    entries.push({
      label: 'Close tab',
      icon: <IconTrash />,
      danger: true,
      onClick: () => void store.removeTab(id)
    })
    return entries
  }

  /**
   * Every open tab of the workspace with its preset badge and its session's attention state, so a
   * tab in a strip with no room for it - or in another pane entirely - can still be found.
   */
  const overflowEntries = (): MenuEntry[] =>
    allTabs.map((tab) => {
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

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    writeTabDrag(e.dataTransfer, { id, slot })
    setDragId(id)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!isTabDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Measured live, because the strip scrolls and the tabs are not a fixed width.
    const spans = tabs.map((t) => {
      const rect = tabRefs.current.get(t.id)?.getBoundingClientRect()
      return { left: rect?.left ?? 0, width: rect?.width ?? 0 }
    })
    setDropAt(dropIndexAt(spans, e.clientX))
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    // Crossing from the strip onto a tab inside it fires a leave that must not clear the target.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropAt(null)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    const drag = readTabDrag(e.dataTransfer)
    const insertAt = dropAt
    setDropAt(null)
    setDragId(null)
    if (!drag || insertAt === null) return
    const ids = tabs.map((t) => t.id)
    const index = dropTargetIndex(ids, drag.id, insertAt)
    // A drop that names the place the tab already occupies is a no-op, and round-tripping it
    // through the main process would repaint the whole group for nothing.
    if (drag.slot === slot && ids[index] === drag.id) return
    void store.moveTab(drag.id, slot, index)
  }

  const dropIndicator = (index: number): React.ReactNode =>
    dropAt === index ? <span className="ix-tabs__drop" aria-hidden="true" /> : null

  return (
    <div
      className={`ix-tabbar${marksFocus ? ' ix-tabbar--focused' : ''}`}
      aria-label={`Pane ${slot + 1} tabs`}
    >
      <div
        className="ix-tabs"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {tabs.map((tab, index) => (
          <Fragment key={tab.id}>
            {dropIndicator(index)}
            <TabItem
              tab={tab}
              active={tab.id === activeTabId}
              status={statusOf(tab.id)}
              workItem={workItems[tab.id]}
              renaming={renamingId === tab.id}
              renameValue={renameValue}
              dragging={dragId === tab.id}
              itemRef={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              onActivate={() => void store.setActiveTab(tab.id)}
              onStartRename={() => startRename(tab.id, tab.title)}
              onRenameChange={setRenameValue}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingId(null)}
              onClose={() => void store.removeTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id: tab.id })
              }}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragEnd={() => {
                setDragId(null)
                setDropAt(null)
              }}
            />
          </Fragment>
        ))}
        {dropIndicator(tabs.length)}
        <PresetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={(preset) => void openTabInGroup(slot, preset)}
        />
      </div>
      {carriesTools && (
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
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu.id)}
          onClose={() => setMenu(null)}
        />
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
