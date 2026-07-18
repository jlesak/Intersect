import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { NewWorkItemRef, WorkItemCandidateGroup, WorkItemSource } from '@common/domain'
import { useProjectsStore } from '@renderer/features/projects'
import { Dialog } from '@renderer/shared/ui/Dialog'
import { useWorkItemsStore } from '../store'
import * as api from '../ipc'

const GROUP_LABELS: Record<WorkItemSource, string> = {
  jira: 'Jira issues',
  todo: 'TODO tasks',
  'ado-pr': 'Pull requests'
}

/**
 * The candidate groups flattened into one keyboard-navigable list, keeping each candidate's
 * group so the rendering can emit a heading whenever the group changes.
 */
export function flattenGroups(
  groups: WorkItemCandidateGroup[]
): { source: WorkItemSource; ref: NewWorkItemRef }[] {
  return groups.flatMap((group) =>
    group.candidates.map((ref) => ({ source: group.source, ref }))
  )
}

/** The searchable list body, presentational so tests can render it statically. */
export function WorkItemPickerList({
  groups,
  selected,
  projectNames,
  onPick
}: {
  groups: WorkItemCandidateGroup[]
  selected: number
  projectNames: Record<string, string>
  onPick: (ref: NewWorkItemRef) => void
}) {
  const flat = flattenGroups(groups)
  if (flat.length === 0) {
    return <div className="ix-wi-picker__empty">No matching work items</div>
  }
  let index = -1
  return (
    <div className="ix-wi-picker__list" role="listbox" aria-label="Work items">
      {groups.map((group) => (
        <div key={group.source} className="ix-wi-picker__group">
          <div className="ix-wi-picker__heading">{GROUP_LABELS[group.source]}</div>
          {group.candidates.map((ref) => {
            index += 1
            const i = index
            return (
              <button
                key={`${ref.source}:${ref.externalKey}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                className={`ix-wi-picker__item${i === selected ? ' ix-wi-picker__item--active' : ''}`}
                onClick={() => onPick(ref)}
              >
                <span className="ix-wi-picker__key">{ref.snapshot.key}</span>
                <span className="ix-wi-picker__title">{ref.snapshot.title}</span>
                {ref.projectId !== null && projectNames[ref.projectId] !== undefined && (
                  <span className="ix-wi-picker__project">{projectNames[ref.projectId]}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * The searchable work-item picker for one tab: type to search every source's cache (key and
 * title), arrows + Enter to assign, with a Clear action when the tab already carries an item.
 * Mounted globally by WorkItemPickerHost and opened through the store's pickerTabId.
 */
function WorkItemPickerDialog({ tabId }: { tabId: string }) {
  const workspaceId = useWorkItemsStore((s) => s.workspaceId)
  const current = useWorkItemsStore((s) => s.byTabId[tabId])
  const projects = useProjectsStore((s) => s.projects)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<WorkItemCandidateGroup[]>([])
  const [selected, setSelected] = useState(0)
  // Answers can land out of order; only the latest request may set the list.
  const requestSeq = useRef(0)

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects]
  )

  useEffect(() => {
    const seq = ++requestSeq.current
    void api
      .searchCandidates(query, workspaceId)
      .then((result) => {
        if (requestSeq.current !== seq) return
        setGroups(result)
        setSelected(0)
      })
      .catch(() => {})
  }, [query, workspaceId])

  const close = (): void => useWorkItemsStore.getState().closePicker()
  const pick = (ref: NewWorkItemRef): void => {
    void useWorkItemsStore.getState().assign(tabId, ref)
    close()
  }

  const flat = flattenGroups(groups)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[selected]) pick(flat[selected].ref)
    }
  }

  return (
    <Dialog
      title={current ? 'Change work item' : 'Set work item'}
      onClose={close}
      actions={
        <>
          {current && (
            <button
              type="button"
              className="ix-btn ix-btn--ghost"
              onClick={() => {
                void useWorkItemsStore.getState().clearPrimary(tabId)
                close()
              }}
            >
              Clear work item
            </button>
          )}
          <button type="button" className="ix-btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <div className="ix-wi-picker">
        {current && (
          <div className="ix-wi-picker__current">
            Current: <strong>{current.snapshot.key}</strong> · {current.snapshot.title}
          </div>
        )}
        <input
          className="ix-input"
          autoFocus
          placeholder="Search by key or title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
        />
        <WorkItemPickerList
          groups={groups}
          selected={selected}
          projectNames={projectNames}
          onPick={pick}
        />
      </div>
    </Dialog>
  )
}

/** Mounts globally (like the command palette) and shows the picker for the store's target tab. */
export function WorkItemPickerHost() {
  const pickerTabId = useWorkItemsStore((s) => s.pickerTabId)
  if (pickerTabId === null) return null
  return <WorkItemPickerDialog tabId={pickerTabId} />
}
