import type { TimeEntry } from '@common/domain'
import { formatTotal, totalMs } from './time'

/**
 * The shown week rendered for a company timesheet, in the two shapes a timesheet actually wants:
 * a tab-separated block to read and paste into a message, and CSV to import into a sheet. Both
 * carry the same four columns in the same order, and both cover exactly what the board covers,
 * which is Monday through Friday of the shown week.
 *
 * Duration is formatted differently on purpose. The text block repeats the board's own `1h 30m`,
 * so what is pasted reads like what was on screen. CSV writes decimal hours, because a timesheet
 * column has to add up and no spreadsheet sums `1h 30m`.
 */

const COLUMNS = ['Date', 'Issue', 'Description', 'Duration']

/** Decimal hours to two places, the form a timesheet arithmetic column can sum. */
function decimalHours(ms: number): string {
  return (ms / 3_600_000).toFixed(2)
}

/** Collapse anything that would break a tab-separated line into single spaces. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The tab-separated block: a header line, the entries in the board's own day order, and a total on
 * the last line under the Duration column so it lands in the right place when pasted into a sheet.
 */
export function weekAsText(entries: TimeEntry[]): string {
  const lines = [COLUMNS.join('\t')]
  for (const e of entries) {
    lines.push(
      [e.day, e.issueKey ?? '', oneLine(e.description), formatTotal(e.durationMs)].join('\t')
    )
  }
  lines.push(['Total', '', '', formatTotal(totalMs(entries))].join('\t'))
  return lines.join('\n')
}

/** RFC4180 quoting: quote a field holding a separator, a quote or a line break, doubling quotes. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The CSV form: a header row and one row per entry. There is deliberately no total row, because a
 * total is a summary rather than a record and importing it would add a phantom entry to the sheet.
 * Rows are separated by newlines rather than CRLF, since this goes to the clipboard to be pasted.
 */
export function weekAsCsv(entries: TimeEntry[]): string {
  const rows = [COLUMNS.join(',')]
  for (const e of entries) {
    rows.push(
      [e.day, e.issueKey ?? '', e.description, decimalHours(e.durationMs)].map(csvField).join(',')
    )
  }
  return rows.join('\n')
}
