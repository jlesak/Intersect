import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
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
  selectGroupVisibleTab,
  selectTabList,
  useTabsStore
} from '../store'
import { LayoutPicker } from './LayoutPicker'
import { PresetPicker } from './PresetPicker'
import { TabItem } from './TabItem'
import { dropIndexAt, dropTargetIndex, isTabDrag, readTabDrag, writeTabDrag } from './tabDrag'

/**
 * Open a new terminal directly into one group. Naming the slot is what lets a "+" pressed in
 * another group's bar, or an empty pane's starter buttons, create the tab where it will live -
 * an unnamed slot means the focused group, which is what the keyboard wants.
 */
export async function openTabInGroup(slot: number, preset: Preset): Promise<void> {
  await useTabsStore.getState().createTab(preset, null, null, slot)
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
  // What this group's own pane is rendering, which is the tab this bar marks. The workspace's
  // active tab marks only one tab in the whole split, leaving the other bars showing a terminal
  // whose name is not picked out in the strip above it.
  const visibleTab = useTabsStore((s) => selectGroupVisibleTab(s, slot))
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const layout = useTabsStore((s) => s.layout)
  const focusedSlot = useTabsStore(selectFocusedSlot)
  const presetPickerOpen = useTabsStore((s) => s.presetPickerOpen)
  const revealRequest = useTabsStore((s) => s.revealRequest)
  const attention = useAttentionStore((s) => s.status)
  const workItems = useWorkItemsStore((s) => s.byTabId)
  const store = useTabsStore.getState()

  const focused = slot === focusedSlot
  // Telling the focused group from the rest only earns its keep once there is a rest to tell it
  // from, so the single layout's one bar carries neither marker and keeps the plain treatment.
  const split = layout !== 'single'
  const marksFocus = focused && split
  const marksUnfocused = !focused && split
  const carriesTools = slot === toolsSlot(layout)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [moveStatus, setMoveStatus] = useState('')
  const [clickedPicker, setClickedPicker] = useState(false)
  const overflowRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  /**
   * Write a sentence into the bar's live region. A live region is read out when its contents
   * change, and holding an arrow at the end of a strip produces the same sentence over and over,
   * so a repeat alternates a trailing no-break space: silent to a reader, a change to the region,
   * and not subject to the whitespace collapsing an ordinary space would go through.
   */
  const announce = (sentence: string): void =>
    setMoveStatus((current) => (current === sentence ? `${sentence}\u00a0` : sentence))

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

  // A request naming a tab this group does not hold finds no element and passes straight through,
  // so every bar can watch the same request and only the one that owns the tab scrolls.
  useEffect(() => {
    if (revealRequest) revealTab(revealRequest.id)
  }, [revealRequest])

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
          // Asked of every bar rather than scrolled here: the tab picked usually belongs to
          // another group, and picking the tab that is already active leaves the activation
          // effect nothing to react to while the user still asked to be shown that tab.
          store.requestReveal(tab.id)
        }
      }
    })

  /**
   * The bar's keyboard layer, which is what the drag owes anyone who is not using a mouse:
   * Enter or Space shows the tab in this pane, the arrows walk the strip, and holding Shift
   * carries the tab along with them. Moving a tab into another pane stays with the context menu's
   * "Open in pane N", which the tabs being focusable finally makes reachable.
   */
  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>, id: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void store.setActiveTab(id)
      return
    }
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    const from = tabs.findIndex((t) => t.id === id)
    if (step === 0 || from === -1) return
    e.preventDefault()

    if (!e.shiftKey) {
      // Wrapping, so a strip can be walked end to end without ever reversing direction.
      tabRefs.current.get(tabs[(from + step + tabs.length) % tabs.length].id)?.focus()
      return
    }
    const to = from + step
    const title = tabs[from].title
    // Said out loud either way: a move that cannot happen is otherwise indistinguishable from a
    // key that did not register.
    if (to < 0 || to >= tabs.length) {
      announce(`${title} is already ${step < 0 ? 'first' : 'last'} in pane ${slot + 1}.`)
      return
    }
    announce(`${title} moved to position ${to + 1} of ${tabs.length} in pane ${slot + 1}.`)
    void store.moveTab(id, slot, to)
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    writeTabDrag(e.dataTransfer, { id, slot })
    setDragId(id)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!isTabDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // The caret says where in this strip; the pane the stage lights up says which pane, which is
    // the part the user needs while aiming across a split.
    store.setDropSlot(slot)
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
    if (useTabsStore.getState().dropSlot === slot) store.setDropSlot(null)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    const drag = readTabDrag(e.dataTransfer)
    const insertAt = dropAt
    setDropAt(null)
    setDragId(null)
    store.setDropSlot(null)
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
      className={`ix-tabbar${marksFocus ? ' ix-tabbar--focused' : ''}${
        marksUnfocused ? ' ix-tabbar--unfocused' : ''
      }`}
    >
      <div
        className="ix-tabs"
        role="tablist"
        aria-label={`Pane ${slot + 1} tabs`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {tabs.map((tab, index) => (
          <Fragment key={tab.id}>
            {dropIndicator(index)}
            <TabItem
              tab={tab}
              active={tab.id === visibleTab?.id}
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
              position={index + 1}
              total={tabs.length}
              onContextMenu={(e) => {
                e.preventDefault()
                // The context-menu key fires this with no pointer position at all, so the tab
                // itself is where the menu goes when there is nothing else to go by.
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ x: e.clientX || rect.left, y: e.clientY || rect.bottom, id: tab.id })
              }}
              onKeyDown={(e) => handleTabKeyDown(e, tab.id)}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragEnd={() => {
                setDragId(null)
                setDropAt(null)
                // A drag abandoned with Escape ends here and nowhere else, so the pane it was
                // last aimed at has to be let go of here too.
                store.setDropSlot(null)
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
      {/* Where a keyboard move is said out loud. Off-screen: the strip has no room for it, and a
          sighted user has just watched the tab jump. */}
      <span className="ix-tabbar__status" role="status" aria-live="polite">
        {moveStatus}
      </span>
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
