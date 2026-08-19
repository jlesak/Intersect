/**
 * The in-memory capture renderer tests assert log records against.
 *
 * The renderer logger reaches Electron main through `window.intersect.log`, so a test only has to
 * put a collecting `write` there. Whatever else a test already stubbed on the bridge is kept, since
 * most renderer tests stand up their own IPC surface before anything logs. Colocated with the
 * logger it serves, and imported only by tests.
 */
export function captureRendererLog(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  const host = window as unknown as { intersect?: Record<string, unknown> }
  host.intersect = {
    ...host.intersect,
    log: { write: (record: unknown): void => void records.push(record as Record<string, unknown>) }
  }
  return records
}
