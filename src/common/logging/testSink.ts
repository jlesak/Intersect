import type { LogSink } from './logger'

/**
 * In-memory sink for tests: collects the serialised lines a logger produced so a test can assert on
 * them without touching the filesystem.
 */
export function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

/** Parse a fake sink's captured lines back into records, in the order they were written. */
export function readRecords(sink: { lines: string[] }): Array<Record<string, unknown>> {
  return sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}
