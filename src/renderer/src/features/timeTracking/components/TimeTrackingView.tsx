import { useEffect } from 'react'
import { dayKeyOf, weekdayKeys } from '@common/week'
import { IconChevronLeft, IconChevronRight } from '@renderer/shared/ui/icons'
import { useTimeTrackingStore } from '../store'
import { useAgentRuntimeStore } from '../agentRuntimeStore'
import { formatTotal, formatWeekRange, groupByDay, totalMs } from '../time'
import { DayColumn } from './DayColumn'

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

/**
 * The Time Tracking section's main region: a topbar (week navigation + weekly total) over the
 * five-weekday board. Loads the current week on first mount, mirroring how SessionsView hydrates.
 */
export function TimeTrackingView() {
  const weekStart = useTimeTrackingStore((s) => s.weekStart)
  const entries = useTimeTrackingStore((s) => s.entries)
  const status = useTimeTrackingStore((s) => s.status)
  const error = useTimeTrackingStore((s) => s.error)
  const runtimeByDay = useAgentRuntimeStore((s) => s.byDay)

  useEffect(() => {
    void useTimeTrackingStore.getState().hydrate()
  }, [])

  // The agent-runtime figures track the shown week alongside the worklog board.
  useEffect(() => {
    void useAgentRuntimeStore.getState().loadWeek(weekStart)
  }, [weekStart])

  const days = weekdayKeys(weekStart)
  const byDay = groupByDay(entries)
  const today = dayKeyOf(Date.now())

  return (
    <div className="ix-main">
      <div className="ix-tt">
        <div className="ix-tt__topbar">
          <span className="ix-tt__title">Time Tracking</span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            onClick={() => void useTimeTrackingStore.getState().goToday()}
          >
            Today
          </button>
          <div className="ix-tt__nav">
            <button
              type="button"
              className="ix-iconbtn"
              title="Previous week"
              onClick={() => void useTimeTrackingStore.getState().prevWeek()}
            >
              <IconChevronLeft width={13} height={13} />
            </button>
            <span className="ix-tt__range">{formatWeekRange(weekStart)}</span>
            <button
              type="button"
              className="ix-iconbtn"
              title="Next week"
              onClick={() => void useTimeTrackingStore.getState().nextWeek()}
            >
              <IconChevronRight width={13} height={13} />
            </button>
          </div>
          <span className="ix-tt__total">{formatTotal(totalMs(entries))} total</span>
        </div>

        {status === 'error' && (
          <div className="ix-tt__error">
            <span>Could not load the week{error ? `: ${error}` : ''}</span>
            <button
              type="button"
              className="ix-btn ix-btn--ghost"
              onClick={() => void useTimeTrackingStore.getState().loadWeek(weekStart)}
            >
              Try again
            </button>
          </div>
        )}

        <div className="ix-tt__board">
          {days.map((day, i) => (
            <DayColumn
              key={day}
              day={day}
              name={DAY_NAMES[i]}
              entries={byDay.get(day) ?? []}
              isToday={day === today}
              runtime={runtimeByDay[day]}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
