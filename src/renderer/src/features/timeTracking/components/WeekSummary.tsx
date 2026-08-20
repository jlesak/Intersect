import { useMemo } from 'react'
import { useProjectsStore } from '@renderer/features/projects'
import { IconChevronDown, IconChevronRight } from '@renderer/shared/ui/icons'
import { useTimeTrackingStore } from '../store'
import { formatTotal } from '../time'
import { rollupByIssue, rollupByProject, type RollupRow } from '../rollup'

/**
 * The shown week rolled up two ways, over the same entries the board and the grand total read, so
 * the three figures on screen can never disagree. The panel starts collapsed and its header stays
 * visible either way, because the header also carries the timesheet export.
 *
 * Both rollups are derived here with useMemo rather than in a selector: they build fresh nested
 * arrays, which would leave the store snapshot unstable and re-render this panel without end.
 */
export function WeekSummary() {
  const entries = useTimeTrackingStore((s) => s.entries)
  const open = useTimeTrackingStore((s) => s.summaryOpen)
  const projects = useProjectsStore((s) => s.projects)
  const overrides = useProjectsStore((s) => s.overrides)

  const byIssue = useMemo(() => rollupByIssue(entries), [entries])
  const byProject = useMemo(
    () => rollupByProject(entries, projects, overrides),
    [entries, projects, overrides]
  )

  return (
    <section className="ix-tt-summary">
      <div className="ix-tt-summary__head">
        <button
          type="button"
          className="ix-tt-summary__toggle"
          aria-expanded={open}
          onClick={() => useTimeTrackingStore.getState().toggleSummary()}
        >
          {open ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
          Summary
        </button>
        {/* Counts the named buckets alone: the catch-alls are not an issue and not a project, and
            counting them here would overstate how much of the week is attributed. */}
        <span className="ix-tt-summary__count">
          {named(byIssue)} issue{named(byIssue) === 1 ? '' : 's'} · {named(byProject)} project
          {named(byProject) === 1 ? '' : 's'}
        </span>
        {/* The board is Monday to Friday, and so is everything copied from it. The titles say so
            rather than leaving someone to discover a missing Saturday in their timesheet. */}
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          title="Copy the shown week (Monday to Friday) as tab-separated text"
          onClick={() => void useTimeTrackingStore.getState().copyWeek('text')}
        >
          Copy text
        </button>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          title="Copy the shown week (Monday to Friday) as CSV, with duration in decimal hours"
          onClick={() => void useTimeTrackingStore.getState().copyWeek('csv')}
        >
          Copy CSV
        </button>
      </div>

      {open && (
        <div className="ix-tt-summary__body">
          <Rollup title="By issue" rows={byIssue} />
          <Rollup title="By project" rows={byProject} />
        </div>
      )}
    </section>
  )
}

/** How many buckets of a rollup are a real issue or project rather than the catch-all. */
function named(rows: RollupRow[]): number {
  return rows.filter((r) => !r.catchAll).length
}

/** One rollup column: its heading and its buckets, heaviest first. */
function Rollup({ title, rows }: { title: string; rows: RollupRow[] }) {
  return (
    <div className="ix-tt-summary__group" data-rollup={title}>
      <div className="ix-tt-summary__group-head">{title}</div>
      {rows.length === 0 ? (
        <div className="ix-tt-summary__empty">Nothing logged this week</div>
      ) : (
        rows.map((row) => (
          <div key={row.key} className="ix-tt-summary__row">
            <span
              className={`ix-tt-summary__label${row.catchAll ? ' ix-tt-summary__label--catch-all' : ''}`}
              title={row.label}
            >
              {row.label}
            </span>
            <span className="ix-tt-summary__entries">{row.entries}</span>
            <span className="ix-tt-summary__total">{formatTotal(row.totalMs)}</span>
          </div>
        ))
      )}
    </div>
  )
}
