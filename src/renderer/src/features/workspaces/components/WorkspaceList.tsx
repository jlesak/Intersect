import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { disposeWorkspaceSessions } from '@renderer/features/terminal'
import { ContextMenu } from '@renderer/shared/ui/ContextMenu'
import { IconFolder, IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { selectWorkspaceList, useWorkspacesStore } from '../store'

/** The sidebar body: the workspace list plus the add-workspace affordance. */
export function WorkspaceList() {
  const workspaces = useWorkspacesStore(useShallow(selectWorkspaceList))
  const selectedId = useWorkspacesStore((s) => s.selectedWorkspaceId)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  const beginRename = (id: string, name: string): void => {
    setRenamingId(id)
    setRenameValue(name)
  }
  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) void useWorkspacesStore.getState().rename(renamingId, renameValue.trim())
    setRenamingId(null)
  }
  const add = async (): Promise<void> => {
    const path = await useWorkspacesStore.getState().pickFolder()
    if (!path) return
    const ws = await useWorkspacesStore.getState().create(path)
    if (ws) beginRename(ws.id, ws.name)
  }
  const remove = (id: string): void => {
    void useWorkspacesStore.getState().remove(id)
    disposeWorkspaceSessions(id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="jv-sidebar__section">
        <span className="jv-eyebrow">Workspaces</span>
      </div>

      <div className="jv-sidebar__list">
        {workspaces.length === 0 && (
          <div style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>None yet.</div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            role="button"
            tabIndex={0}
            className={`jv-ws${w.id === selectedId ? ' jv-ws--active' : ''}`}
            onMouseDown={() => renamingId !== w.id && void useWorkspacesStore.getState().select(w.id)}
            onDoubleClick={() => beginRename(w.id, w.name)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: w.id })
            }}
          >
            {renamingId === w.id ? (
              <input
                className="jv-ws__rename"
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
              <>
                <span className="jv-ws__name">{w.name}</span>
                <span className="jv-ws__path">{w.folderPath}</span>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="jv-sidebar__foot">
        <button type="button" className="jv-add" onClick={() => void add()}>
          <IconFolder />
          Add workspace
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            {
              label: 'Rename',
              icon: <IconPencil />,
              onClick: () => {
                const w = workspaces.find((w) => w.id === menu.id)
                if (w) beginRename(w.id, w.name)
              }
            },
            { separator: true },
            { label: 'Delete workspace', icon: <IconTrash />, danger: true, onClick: () => remove(menu.id) }
          ]}
        />
      )}
    </div>
  )
}
