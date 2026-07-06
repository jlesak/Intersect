import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PRESET_META } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { slotCount } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconChevronLeft, IconChevronRight, IconClose, IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { selectTabList, useTabsStore } from '../store'
import { LayoutPicker } from './LayoutPicker'
import { PresetPicker } from './PresetPicker'

export function TabBar() {
  const tabs = useTabsStore(useShallow(selectTabList))
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const workspaceId = useTabsStore((s) => s.workspaceId)
  const layout = useTabsStore((s) => s.layout)
  const attention = useAttentionStore((s) => s.status)
  const store = useTabsStore.getState()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

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
    const entries: MenuEntry[] = [
      { label: 'Rename', icon: <IconPencil />, onClick: () => startRename(id, tabs[i].title) },
      { label: 'Move left', icon: <IconChevronLeft />, disabled: i <= 0, onClick: () => move(id, -1) },
      {
        label: 'Move right',
        icon: <IconChevronRight />,
        disabled: i >= tabs.length - 1,
        onClick: () => move(id, 1)
      }
    ]
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

  return (
    <div className="ix-tabbar">
      <div className="ix-tabs">
        {tabs.map((tab) => {
          const status = workspaceId ? attention[makeSessionId(workspaceId, tab.id)] : undefined
          return (
          <div
            key={tab.id}
            className={`ix-tab${tab.id === activeTabId ? ' ix-tab--active' : ''}${status ? ` ix-tab--${status}` : ''}`}
            onMouseDown={() => renamingId !== tab.id && void store.setActiveTab(tab.id)}
            onDoubleClick={() => startRename(tab.id, tab.title)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: tab.id })
            }}
          >
            <span className="ix-tab__preset">{PRESET_META[tab.preset].badge}</span>
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
        <PresetPicker onPick={(preset) => void store.createTab(preset)} />
      </div>
      <div className="ix-tabbar__tools">
        <LayoutPicker layout={layout} onChange={(l) => void store.setLayout(l)} />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.id)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
