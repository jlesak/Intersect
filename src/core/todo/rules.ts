import type { TodoQuery, TodoRecurrence, TodoSize, TodoTask } from '@common/domain'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const SIZES: TodoSize[] = ['XS', 'S', 'M', 'L', 'XL']

export function validDay(day: string): boolean {
  if (!DAY.test(day)) return false
  const [year, month, date] = day.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, date))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
}

export function validateSchedule(day: string | null, time: string | null,
  recurrence: TodoRecurrence | null): void {
  if (day !== null && !validDay(day)) throw new Error(`Invalid due day: ${day}`)
  if (time !== null && !TIME.test(time)) throw new Error(`Invalid due time: ${time}`)
  if (time !== null && day === null) throw new Error('A due time requires a due day')
  if (recurrence !== null) {
    if (day === null || !validDay(recurrence.anchorDay) || !Number.isSafeInteger(recurrence.interval) ||
      recurrence.interval < 1 || !['fixed', 'after_completion'].includes(recurrence.mode) ||
      !['day', 'week', 'month', 'year'].includes(recurrence.unit)) {
      throw new Error('Invalid recurrence')
    }
  }
}

function parts(day: string): [number, number, number] {
  return day.split('-').map(Number) as [number, number, number]
}
function key(year: number, month: number, date: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${date.toString().padStart(2, '0')}`
}
function clamp(year: number, month: number, date: number): string {
  return key(year, month, Math.min(date, new Date(Date.UTC(year, month, 0)).getUTCDate()))
}
function nth(anchor: string, unit: TodoRecurrence['unit'], count: number): string {
  const [year, month, date] = parts(anchor)
  if (unit === 'day' || unit === 'week') {
    const next = new Date(Date.UTC(year, month - 1, date + count * (unit === 'week' ? 7 : 1)))
    return key(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
  }
  if (unit === 'month') {
    const index = year * 12 + month - 1 + count
    return clamp(Math.floor(index / 12), index % 12 + 1, date)
  }
  return clamp(year + count, month, date)
}

export function nextOccurrence(rule: TodoRecurrence, occurrenceDay: string, today: string): string {
  if (rule.mode === 'after_completion') return nth(today, rule.unit, rule.interval)
  const floor = occurrenceDay > today ? occurrenceDay : today
  for (let n = 1; n < 100000; n++) {
    const candidate = nth(rule.anchorDay, rule.unit, n * rule.interval)
    if (candidate > floor) return candidate
  }
  throw new Error('Recurrence exceeds supported range')
}

export function validateQuery(query: TodoQuery): void {
  if (query.version !== 1 ||
    (query.projects !== undefined && (!Array.isArray(query.projects) ||
      query.projects.some((id) => id !== null && typeof id !== 'string'))) ||
    (query.tags !== undefined && (!Array.isArray(query.tags) || query.tags.some((id) => typeof id !== 'string'))) ||
    (query.priorities !== undefined && (!Array.isArray(query.priorities) ||
      query.priorities.some((p) => ![1, 2, 3, 4].includes(p)))) ||
    (query.date !== undefined && !['today', 'todayView', 'overdue', 'upcoming', 'any'].includes(query.date)) ||
    (query.size !== undefined && (!SIZES.includes(query.size.value) ||
      !['exact', 'atMost'].includes(query.size.mode)))) throw new Error('Invalid TODO filter')
}

export function matchesQuery(task: TodoTask, query: TodoQuery, today: string): boolean {
  if (task.doneAt !== null) return false
  if (query.projects?.length && !query.projects.includes(task.projectId ?? null)) return false
  if (query.tags?.length && !query.tags.some((id) => task.tagIds?.includes(id))) return false
  if (query.priorities?.length && !query.priorities.includes(task.priority)) return false
  if (query.size) {
    if (!task.size) return false
    const actual = SIZES.indexOf(task.size)
    const limit = SIZES.indexOf(query.size.value)
    if (query.size.mode === 'exact' ? actual !== limit : actual > limit) return false
  }
  if (query.date === 'today' && task.dueDay !== today) return false
  if (query.date === 'todayView' && (task.dueDay === null || task.dueDay > today)) return false
  if (query.date === 'overdue' && (task.dueDay === null || task.dueDay >= today)) return false
  if (query.date === 'upcoming' && (task.dueDay === null || task.dueDay < today)) return false
  return true
}

export function byDue(a: TodoTask, b: TodoTask): number {
  return (a.dueDay ?? '9999-12-31').localeCompare(b.dueDay ?? '9999-12-31') ||
    (a.dueTime ?? '').localeCompare(b.dueTime ?? '') || a.sortOrder - b.sortOrder
}
