import { useState } from 'react'
import type { TodoPriority, TodoProject, TodoQuery, TodoSavedFilter, TodoSize, TodoTag } from '@common/domain'

const priorities: TodoPriority[] = [1, 2, 3, 4]
const sizes: TodoSize[] = ['XS', 'S', 'M', 'L', 'XL']
/**
 * Edits a saved filter. A reference to a deleted project or tag stays in the draft, checked and
 * labelled, because dropping it would silently widen the filter; the owner unchecks it to repair.
 */
export function TodoFilterEditor({ projects, tags, metadataReady, initial, save, cancel }: {
  projects: TodoProject[]
  tags: TodoTag[]
  /** Whether projects and tags have loaded; before that a missing reference is unknown, not deleted. */
  metadataReady: boolean
  initial?: TodoSavedFilter
  save(name: string, query: TodoQuery): void
  cancel(): void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [query, setQuery] = useState<TodoQuery>(initial?.query ?? { version: 1 })
  const toggle = <T,>(items: T[] | undefined, item: T): T[] =>
    items?.includes(item) ? items.filter((value) => value !== item) : [...(items ?? []), item]
  return <form className="ix-todo-filter-editor" onSubmit={(event) => {
    event.preventDefault()
    if (name.trim()) save(name, query)
  }}>
    <input className="ix-input" aria-label="Filter name" placeholder="Filter name" value={name}
      onChange={(event) => setName(event.target.value)} />
    <div className="ix-todo-filter-editor__group"><strong>Projects</strong>
      {[{ id: null, name: 'Inbox' }, ...projects].map((project) => <label key={project.id ?? 'inbox'}>
        <input type="checkbox" checked={query.projects?.includes(project.id) ?? false}
          onChange={() => setQuery({ ...query, projects: toggle(query.projects, project.id) })} />
        {project.name}</label>)}
      {query.projects?.filter((id) => id !== null && !projects.some((p) => p.id === id))
        .map((id) => <label key={id}><input type="checkbox" checked
          onChange={() => setQuery({ ...query, projects: toggle(query.projects, id) })} />
          {metadataReady ? 'Deleted project' : 'Project not loaded'} ({id})</label>)}
    </div>
    <div className="ix-todo-filter-editor__group"><strong>Tags</strong>
      {tags.map((tag) => <label key={tag.id}><input type="checkbox"
        checked={query.tags?.includes(tag.id) ?? false}
        onChange={() => setQuery({ ...query, tags: toggle(query.tags, tag.id) })} />{tag.name}</label>)}
      {query.tags?.filter((id) => !tags.some((tag) => tag.id === id))
        .map((id) => <label key={id}><input type="checkbox" checked
          onChange={() => setQuery({ ...query, tags: toggle(query.tags, id) })} />
          {metadataReady ? 'Deleted tag' : 'Tag not loaded'} ({id})</label>)}
    </div>
    <label>Date <select className="ix-input ix-todo__control" aria-label="Filter date" value={query.date ?? 'any'}
      onChange={(event) => setQuery({ ...query, date: event.target.value as TodoQuery['date'] })}>
      <option value="any">Any</option><option value="today">Today only</option>
      <option value="overdue">Overdue</option><option value="upcoming">Upcoming</option>
    </select></label>
    <div className="ix-todo-filter-editor__group"><strong>Priority</strong>
      {priorities.map((value) => <label key={value}><input type="checkbox"
        checked={query.priorities?.includes(value) ?? false}
        onChange={() => setQuery({ ...query, priorities: toggle(query.priorities, value) })} />P{value}</label>)}
    </div>
    <label>Size <select className="ix-input ix-todo__control" aria-label="Filter size" value={query.size?.value ?? ''}
      onChange={(event) => setQuery({ ...query, size: event.target.value
        ? { mode: query.size?.mode ?? 'exact', value: event.target.value as TodoSize } : undefined })}>
      <option value="">Any</option>{sizes.map((size) => <option key={size}>{size}</option>)}
    </select></label>
    <label>Size mode <select className="ix-input ix-todo__control" aria-label="Filter size mode" value={query.size?.mode ?? 'exact'}
      onChange={(event) => setQuery({ ...query, size: query.size
        ? { ...query.size, mode: event.target.value as 'exact' | 'atMost' } : undefined })}>
      <option value="exact">Exactly</option><option value="atMost">At most</option>
    </select></label>
    <div><button type="button" className="ix-btn ix-btn--ghost" onClick={cancel}>Cancel</button>
      <button type="submit" className="ix-btn ix-btn--primary">Save filter</button></div>
  </form>
}
