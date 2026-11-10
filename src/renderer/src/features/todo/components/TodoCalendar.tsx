import { useState } from 'react'
import type { TodoTask } from '@common/domain'

export function monthDays(month: string): (string | null)[] {
  const [year, number] = month.split('-').map(Number)
  const first = new Date(year, number - 1, 1)
  const last = new Date(year, number, 0).getDate()
  const prefix = (first.getDay() + 6) % 7
  return [...Array<string | null>(prefix).fill(null),
    ...Array.from({ length: last }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)]
}
export function shiftMonth(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number)
  const next = new Date(year, number - 1 + offset, 1)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
}

export function TodoCalendar({ tasks, today, openTask }: {
  tasks: TodoTask[]
  today: string
  openTask(id: string): void
}) {
  const [month, setMonth] = useState(today.slice(0, 7))
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const grouped = new Map<string, TodoTask[]>()
  for (const task of [...tasks].sort((a, b) =>
    (a.dueDay ?? '').localeCompare(b.dueDay ?? '') ||
    (a.dueTime ?? '').localeCompare(b.dueTime ?? ''))) {
    if (!task.dueDay) continue
    const entries = grouped.get(task.dueDay) ?? []
    entries.push(task)
    grouped.set(task.dueDay, entries)
  }
  const entries = expandedDay ? grouped.get(expandedDay) ?? [] : []
  return <div className="ix-todo-calendar">
    <div className="ix-todo-calendar__head">
      <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
      <strong>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
        .format(new Date(`${month}-01T12:00:00`))}</strong>
      <button type="button" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
    </div>
    <div className="ix-todo-calendar__grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) =>
        <span className="ix-todo-calendar__weekday" key={day}>{day}</span>)}
      {monthDays(month).map((day, index) => <div className="ix-todo-calendar__day" key={day ?? `blank-${index}`}>
        {day && <><strong>{Number(day.slice(-2))}</strong>
          {(grouped.get(day) ?? []).slice(0, 3).map((task) => <button type="button"
            key={task.id} onClick={() => openTask(task.id)} title={task.text}>
            {task.dueTime ? `${task.dueTime} ` : ''}{task.text}
          </button>)}
          {(grouped.get(day)?.length ?? 0) > 3 && <button type="button"
            onClick={() => setExpandedDay(day)}>Show all ({grouped.get(day)?.length})</button>}
        </>}
      </div>)}
    </div>
    {expandedDay && <div className="ix-todo-calendar__expanded">
      <div><strong>{expandedDay}</strong><button type="button" onClick={() => setExpandedDay(null)}>Close</button></div>
      <div className="ix-todo-calendar__expanded-list">
        {entries.map((task) => <button type="button" key={task.id} onClick={() => openTask(task.id)}>
          {task.dueTime ? `${task.dueTime} ` : ''}{task.text}</button>)}
      </div>
    </div>}
  </div>
}
