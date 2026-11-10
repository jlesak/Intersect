import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { TodoPriority, TodoRecurrence, TodoSize, TodoTask } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { launchFromTodoTask } from '@renderer/features/workItems'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconCalendar, IconPencil, IconPlay, IconTrash } from '@renderer/shared/ui/icons'
import { useNow } from '@renderer/shared/ui/useNow'
import { copyTodoTask } from '../clipboard'
import { formatDueDay } from '../due'
import { parseDueFromText } from '../dueInput'
import { useTodoStore } from '../store'
import { TodoItem } from './TodoItem'
import { TodoCalendar } from './TodoCalendar'
import { TodoFilterEditor } from './TodoFilterEditor'

/** Move one id to an insertion index, accounting for the removal shift. */
function moveId(ids: string[], id: string, insertionIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const requestedIndex = from < insertionIndex ? insertionIndex - 1 : insertionIndex
  const to = Math.max(0, Math.min(ids.length - 1, requestedIndex))
  if (from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * How long an arriving task stays marked. Long enough to find the row after the section switch,
 * short enough that the mark cannot be mistaken for a persistent selection.
 */
const FOCUS_MARK_MS = 2500
const EMPTY: never[] = []

/**
 * Getting a task out of the app as text. The one thing a TODO row offers that has no button of
 * its own, which is why both the pointer menu and the action bar's overflow carry it.
 */
const copyEntry = (task: TodoTask): MenuEntry => ({
  label: 'Copy task',
  onClick: () => void copyTodoTask(task, dayKeyOf(Date.now()))
})

/**
 * The TODO section's main region. Open tasks use persisted manual ordering; pointer and keyboard
 * interactions both submit the complete order through the optimistic store.
 */
export function TodoView() {
  const open = useTodoStore((s) => s.open)
  const done = useTodoStore((s) => s.done)
  const status = useTodoStore((s) => s.status)
  const error = useTodoStore((s) => s.error)
  const showDone = useTodoStore((s) => s.showDone)
  const pendingFocusId = useTodoStore((s) => s.pendingFocusId)
  const focusResolvedId = useTodoStore((s) => s.focusResolvedId)
  const view = useTodoStore((s) => s.view ?? 'inbox')
  const projectId = useTodoStore((s) => s.activeProjectId)
  const filterId = useTodoStore((s) => s.activeFilterId)
  const projects = useTodoStore((s) => s.projects ?? EMPTY)
  const tags = useTodoStore((s) => s.tags ?? EMPTY)
  const filters = useTodoStore((s) => s.filters ?? EMPTY)
  const queryTasks = useTodoStore((s) => s.queryTasks ?? EMPTY)
  const invalidFilter = useTodoStore((s) => s.invalidFilter)
  const missingTask = useTodoStore((s) => s.missingTask)
  const dayKey = useTodoStore((s) => s.dayKey)
  const clockDay = dayKeyOf(useNow(60_000))

  const [text, setText] = useState('')
  const [dueDay, setDueDay] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [newPriority, setNewPriority] = useState<TodoPriority>(4)
  const [newSize, setNewSize] = useState<TodoSize | ''>('')
  const [newTagIds, setNewTagIds] = useState<string[]>([])
  const [newMode, setNewMode] = useState<TodoRecurrence['mode'] | ''>('')
  const [newUnit, setNewUnit] = useState<TodoRecurrence['unit']>('day')
  const [newInterval, setNewInterval] = useState(1)
  const [showFilterEditor, setShowFilterEditor] = useState(false)
  const [tagName, setTagName] = useState('')
  const [renamingTagId, setRenamingTagId] = useState<string | null>(null)
  const [renamedTagName, setRenamedTagName] = useState('')
  const [showDate, setShowDate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [reorderStatus, setReorderStatus] = useState('')
  const [markedId, setMarkedId] = useState<string | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const rowsRef = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    void useTodoStore.getState().load()
    void useTodoStore.getState().loadPlanning()
  }, [])

  useEffect(() => {
    if (view === 'today') void useTodoStore.getState().refreshView(clockDay)
    else if (useTodoStore.getState().dayKey !== clockDay)
      void useTodoStore.getState().recheckDay()
  }, [view, clockDay])

  useEffect(() => { setShowFilterEditor(false) }, [view, filterId])

  useEffect(() => {
    const recheck = (): void => { void useTodoStore.getState().recheckDay() }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => { window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck) }
  }, [])

  // Land the arrival another surface asked for: bring the row into view and mark it. The request is
  // spent the moment it is honoured, so returning here later does not replay it.
  useEffect(() => {
    if (pendingFocusId === null || focusResolvedId !== pendingFocusId) return
    const row = rowsRef.current.get(pendingFocusId)
    if (!row) return
    useTodoStore.getState().clearFocus()
    setMarkedId(pendingFocusId)
    row.scrollIntoView({ block: 'center' })
  }, [pendingFocusId, focusResolvedId, open, done, view, showDone])

  useEffect(() => {
    if (markedId === null) return
    const timer = setTimeout(() => setMarkedId(null), FOCUS_MARK_MS)
    return () => clearTimeout(timer)
  }, [markedId])

  useEffect(() => {
    if (armedId === null) return
    const disarm = (): void => setArmedId(null)
    window.addEventListener('mouseup', disarm)
    return () => window.removeEventListener('mouseup', disarm)
  }, [armedId])

  /** Drop a task from the renderer-only marks, for a row that is leaving the open list. */
  function forget(id: string): void {
    setSelectedId((current) => (current === id ? null : current))
  }

  function openEditor(id: string): void {
    // The editor is where the row is worked on, so pointing at it is spent.
    setSelectedId(null)
    setEditingId(id)
  }

  function removeTask(id: string): void {
    forget(id)
    void useTodoStore.getState().remove(id)
  }

  /**
   * What a right-click on a task raises: everything the row can do, at the pointer, without
   * aiming at a 12px icon, plus the copy the row itself has no path to. A done task keeps only
   * what still applies, matching the two buttons its own row shows.
   */
  function menuEntriesFor(task: TodoTask, done: boolean): MenuEntry[] {
    const remove: MenuEntry = {
      label: 'Delete',
      icon: <IconTrash />,
      danger: true,
      onClick: () => removeTask(task.id)
    }
    if (done) return [copyEntry(task), { separator: true }, remove]
    return [
      { label: 'Start session', icon: <IconPlay />, onClick: () => launchFromTodoTask(task) },
      { separator: true },
      copyEntry(task),
      { separator: true },
      { label: 'Edit', icon: <IconPencil />, onClick: () => openEditor(task.id) },
      remove
    ]
  }

  const menuTask = menu === null ? undefined : [...open, ...done].find((t) => t.id === menu.id)
  const visibleOpen = view === 'inbox' ? open.filter((task) => !task.projectId)
    : view === 'project' ? open.filter((task) => task.projectId === projectId)
      : view === 'today' || view === 'filter' ? queryTasks : open
  const canReorder = view === 'inbox' || view === 'project'
  const activeFilter = filters.find((filter) => filter.id === filterId)
  const heading = view === 'project' ? projects.find((project) => project.id === projectId)?.name
    : view === 'filter' ? activeFilter?.name : view === 'today' ? 'Today'
      : view === 'upcoming' ? 'Upcoming' : 'Inbox'

  // A date picked by hand is an explicit instruction, so it wins and suppresses the reading of the
  // text entirely: with the picker holding a day, no word is taken out of the title either.
  const today = dayKey ?? clockDay
  const typedDue = dueDay === '' ? parseDueFromText(text, today) : null

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const parsed = typedDue ?? { text: trimmed, dueDay: dueDay || null }
    const scheduled = parsed.dueDay ?? today
    void useTodoStore.getState().add({ text: parsed.text, dueDay: scheduled,
      dueTime: dueTime || null, priority: newPriority, size: newSize || null,
      projectId: view === 'project' ? projectId : null, tagIds: newTagIds,
      recurrence: newMode ? { mode: newMode, unit: newUnit, interval: newInterval,
        anchorDay: scheduled } : null })
    setText('')
    setDueDay('')
    setDueTime('')
    setNewPriority(4)
    setNewSize('')
    setNewTagIds([])
    setNewMode('')
    setShowDate(false)
  }

  function toggleDateInput(): void {
    setShowDate((shown) => {
      if (shown) setDueDay('')
      return !shown
    })
  }

  function persistOrder(ids: string[], movedId: string): void {
    const position = ids.indexOf(movedId) + 1
    const task = visibleOpen.find((candidate) => candidate.id === movedId)
    if (position < 1 || !task) return
    setReorderStatus(`Moved ${task.text} to position ${position} of ${ids.length}.`)
    void useTodoStore.getState().reorder(ids)
  }

  function handleKeyboardMove(id: string, delta: -1 | 1): void {
    const ids = visibleOpen.map((task) => task.id)
    const from = ids.indexOf(id)
    const task = visibleOpen[from]
    if (!task) return
    const to = from + delta
    if (to < 0 || to >= ids.length) {
      setReorderStatus(`${task.text} is already ${delta < 0 ? 'first' : 'last'}.`)
      return
    }
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, id)
    persistOrder(next, id)
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, index: number): void {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    dropIndexRef.current = e.clientY < rect.top + rect.height / 2 ? index : index + 1
  }

  function handleDragEnd(): void {
    setDragId(null)
    setArmedId(null)
    dropIndexRef.current = null
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    const id = dragId
    const target = dropIndexRef.current
    handleDragEnd()
    if (!id || target === null) return
    const current = visibleOpen.map((task) => task.id)
    const next = moveId(current, id, target)
    if (next === current) return
    persistOrder(next, id)
  }

  return (
    <div className="ix-main">
      <div className="ix-todo">
        <div className="ix-todo__head">
          <span className="ix-todo__title">TODO · {heading}</span>
          <button type="button" className="ix-btn ix-btn--ghost" onClick={() =>
            setShowFilterEditor(true)}>{view === 'filter' ? 'Edit filter' : 'New filter'}</button>
          <button
            type="button"
            className="ix-todo__done-link"
            onClick={() => useTodoStore.getState().toggleShowDone()}
          >
            {showDone ? 'Hide done' : `Show done (${done.length})`}
          </button>
        </div>

        {missingTask && <div className="ix-todo__error" role="status">Task no longer exists.</div>}
        {view === 'filter' && invalidFilter && <div className="ix-todo__error" role="alert">
          Filtr odkazuje na smazaný projekt nebo štítek
          <button type="button" onClick={() => setShowFilterEditor(true)}>Edit</button>
        </div>}
        {showFilterEditor && <TodoFilterEditor projects={projects} tags={tags}
          initial={view === 'filter' ? activeFilter : undefined}
          cancel={() => setShowFilterEditor(false)}
          save={(name, query) => {
            if (view === 'filter' && filterId) void useTodoStore.getState().updateFilter(filterId, name, query)
            else void useTodoStore.getState().createFilter(name, query)
            setShowFilterEditor(false)
          }} />}

        <div className="ix-todo__tags-manage">
          <span>Tags</span>
          {tags.map((tag) => renamingTagId === tag.id ?
            <form key={tag.id} className="ix-todo__rename-tag" onSubmit={(event) => {
              event.preventDefault()
              if (!renamedTagName.trim()) return
              void useTodoStore.getState().updateTag(tag.id, renamedTagName)
              setRenamingTagId(null)
            }}><input className="ix-input" aria-label="Rename tag" autoFocus
              value={renamedTagName} onChange={(event) => setRenamedTagName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setRenamingTagId(null) }} />
              <button type="submit">Save</button>
              <button type="button" onClick={() => setRenamingTagId(null)}>Cancel</button>
            </form> : <span key={tag.id}>{tag.name}
              <button type="button" title={`Rename tag ${tag.name}`} onClick={() => {
                setRenamingTagId(tag.id)
                setRenamedTagName(tag.name)
              }}>✎</button>
              <button type="button" title={`Delete tag ${tag.name}`} onClick={() =>
                void useTodoStore.getState().removeTag(tag.id)}>×</button>
            </span>)}
          <form onSubmit={(event) => { event.preventDefault()
            if (tagName.trim()) void useTodoStore.getState().createTag(tagName)
            setTagName('') }}>
            <input className="ix-input" aria-label="New tag name" placeholder="New tag"
              value={tagName} onChange={(event) => setTagName(event.target.value)} />
            <button type="submit">Add tag</button>
          </form>
        </div>

        <div className="ix-todo__add">
          <input
            className="ix-input"
            placeholder="Add a task… (Enter)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          {showDate && (
            <><input
              type="date"
              className="ix-input ix-todo__date"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
            /><input type="time" className="ix-input" aria-label="New task due time"
              value={dueTime} onChange={(e) => setDueTime(e.target.value)} /></>
          )}
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            title="Add due date"
            onClick={toggleDateInput}
          >
            <IconCalendar />
          </button>
        </div>

        <div className="ix-todo__add-options">
          <select aria-label="New task priority" value={newPriority}
            onChange={(event) => setNewPriority(Number(event.target.value) as TodoPriority)}>
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>P{value}</option>)}
          </select>
          <select aria-label="New task size" value={newSize}
            onChange={(event) => setNewSize(event.target.value as TodoSize | '')}>
            <option value="">No size</option>
            {['XS', 'S', 'M', 'L', 'XL'].map((size) => <option key={size}>{size}</option>)}
          </select>
          <select aria-label="New task repeat mode" value={newMode}
            onChange={(event) => setNewMode(event.target.value as TodoRecurrence['mode'] | '')}>
            <option value="">No repeat</option><option value="fixed">Fixed</option>
            <option value="after_completion">After completion</option>
          </select>
          {newMode && <><select aria-label="New task repeat unit" value={newUnit}
            onChange={(event) => setNewUnit(event.target.value as TodoRecurrence['unit'])}>
            <option value="day">Day</option><option value="week">Week</option>
            <option value="month">Month</option><option value="year">Year</option>
          </select><input type="number" min="1" aria-label="New task repeat interval"
            value={newInterval} onChange={(event) => setNewInterval(Number(event.target.value))} /></>}
          {tags.map((tag) => <label key={tag.id}><input type="checkbox"
            checked={newTagIds.includes(tag.id)} onChange={() => setNewTagIds((ids) =>
              ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])} />
            {tag.name}</label>)}
        </div>

        {/*
          The line is always here, empty or not. What the typed words mean changes with almost
          every keystroke - "thu" names a day, "thur" names none, "thursday" names one again -
          and a line that came and went would shove the task list up and down under the cursor.
        */}
        <div className="ix-todo__add-hint">
          {typedDue !== null && typedDue.dueDay !== null && (
            <>
              Adds <span className="ix-todo__add-hint-text">{typedDue.text}</span>, due{' '}
              {formatDueDay(typedDue.dueDay, today)}
            </>
          )}
        </div>

        {status === 'error' && (
          <div className="ix-todo__error">Could not load tasks{error ? `: ${error}` : ''}</div>
        )}

        <div className="ix-todo__reorder-status" role="status" aria-live="polite">
          {reorderStatus}
        </div>

        {view === 'upcoming' && <TodoCalendar tasks={open} today={today} openTask={openEditor} />}
        {view === 'upcoming' && editingId && open.some((task) => task.id === editingId) &&
          <TodoItem task={open.find((task) => task.id === editingId)!} done={false} editing
            projects={projects} tags={tags} onToggle={() => {}} onDelete={() => removeTask(editingId)}
            onCancelEdit={() => setEditingId(null)} onSave={(patch) => {
              void useTodoStore.getState().update(editingId, patch)
              setEditingId(null)
            }} />}

        {view !== 'upcoming' && !invalidFilter && status === 'ready' && visibleOpen.length === 0 ? (
          <div className="ix-todo__empty">No tasks yet - add one above.</div>
        ) : view !== 'upcoming' && !invalidFilter ? (
          <div className="ix-todo__list" role="list" aria-label="Open tasks">
            {visibleOpen.map((task, index) => (
              <TodoItem
                key={task.id}
                task={task}
                projects={projects}
                tags={tags}
                done={false}
                editing={editingId === task.id}
                selected={selectedId === task.id}
                focused={markedId === task.id}
                rowRef={(el) => {
                  if (el) rowsRef.current.set(task.id, el)
                  else rowsRef.current.delete(task.id)
                }}
                onToggle={() => {
                  forget(task.id)
                  void useTodoStore.getState().toggleDone(task.id, true)
                }}
                onDelete={() => removeTask(task.id)}
                onSelect={() => setSelectedId(task.id)}
                onStartEdit={() => openEditor(task.id)}
                onContextMenu={(x, y) => {
                  // The menu addresses one task, so the row it was raised on says which.
                  setSelectedId(task.id)
                  setMenu({ x, y, id: task.id })
                }}
                overflow={[copyEntry(task)]}
                onCancelEdit={() => setEditingId(null)}
                onSave={(patch) => {
                  setEditingId(null)
                  void useTodoStore.getState().update(task.id, patch)
                }}
                onStartSession={() => launchFromTodoTask(task)}
                drag={canReorder ? {
                  position: index + 1,
                  total: visibleOpen.length,
                  dragging: dragId === task.id,
                  draggable: armedId === task.id,
                  onHandleMouseDown: () => setArmedId(task.id),
                  onKeyboardMove: (delta) => handleKeyboardMove(task.id, delta),
                  onDragStart: (e) => handleDragStart(e, task.id),
                  onDragOver: (e) => handleDragOver(e, index),
                  onDrop: handleDrop,
                  onDragEnd: handleDragEnd
                } : undefined}
              />
            ))}
          </div>
        ) : null}

        {showDone && (
          <div className="ix-todo__done-drawer">
            <div className="ix-todo__done-head">
              <span className="ix-todo__done-title">Done</span>
              <span className="ix-todo__done-count">{done.length}</span>
            </div>
            <div className="ix-todo__list" role="list" aria-label="Done tasks">
              {done.map((task) => (
                <TodoItem
                  key={task.id}
                  task={task}
                  done
                  focused={markedId === task.id}
                  rowRef={(el) => {
                    if (el) rowsRef.current.set(task.id, el)
                    else rowsRef.current.delete(task.id)
                  }}
                  onToggle={() => void useTodoStore.getState().toggleDone(task.id, false)}
                  onDelete={() => removeTask(task.id)}
                  onContextMenu={(x, y) => setMenu({ x, y, id: task.id })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {menu && menuTask && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntriesFor(menuTask, menuTask.doneAt !== null)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
