import { describe, expect, test, vi } from 'vitest'
import { createSessionIndex } from './sessionIndex'

const line = (o: unknown): string => JSON.stringify(o)

/** A minimal one-user-message session file whose content sets id-independent fields. */
const sessionFile = (over: { title?: string; ts?: string; cwd?: string } = {}): string =>
  [
    line({ type: 'ai-title', aiTitle: over.title ?? 'A session' }),
    line({
      type: 'user',
      message: { content: 'hello' },
      cwd: over.cwd ?? '/repo/one',
      timestamp: over.ts ?? '2026-01-01T00:00:00Z'
    })
  ].join('\n')

/** Build an index over an in-memory map of filePath -> file content. */
function indexOver(files: Record<string, string>) {
  const readFile = vi.fn(async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`)
    return files[path]
  })
  const readDir = vi.fn(async () => Object.keys(files))
  const index = createSessionIndex({ projectsDir: '/projects', readDir, readFile })
  return { index, readFile, readDir }
}

describe('createSessionIndex', () => {
  test('list builds once and then serves from cache', async () => {
    const { index, readDir } = indexOver({
      '/projects/a/one.jsonl': sessionFile(),
      '/projects/b/two.jsonl': sessionFile()
    })
    const first = await index.list()
    const second = await index.list()
    expect(first).toHaveLength(2)
    expect(second).toBe(first)
    expect(readDir).toHaveBeenCalledTimes(1)
  })

  test('refresh always re-scans from disk', async () => {
    const { index, readDir } = indexOver({ '/projects/a/one.jsonl': sessionFile() })
    await index.list()
    await index.refresh()
    expect(readDir).toHaveBeenCalledTimes(2)
  })

  test('summaries are sorted by last activity, newest first', async () => {
    const { index } = indexOver({
      '/projects/a/older.jsonl': sessionFile({ ts: '2026-01-01T00:00:00Z' }),
      '/projects/b/newer.jsonl': sessionFile({ ts: '2026-03-01T00:00:00Z' }),
      '/projects/c/middle.jsonl': sessionFile({ ts: '2026-02-01T00:00:00Z' })
    })
    const list = await index.list()
    expect(list.map((s) => s.id)).toEqual(['newer', 'middle', 'older'])
  })

  test('derives ids from file basenames', async () => {
    const { index } = indexOver({ '/projects/a/abc-123.jsonl': sessionFile() })
    const [only] = await index.list()
    expect(only.id).toBe('abc-123')
    expect(only.filePath).toBe('/projects/a/abc-123.jsonl')
  })

  test('getTranscript reads and parses the session file', async () => {
    const { index } = indexOver({
      '/projects/a/one.jsonl': [
        line({ type: 'ai-title', aiTitle: 'A session' }),
        line({ type: 'user', message: { content: 'do the thing' }, cwd: '/repo/one' }),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
      ].join('\n')
    })
    const t = await index.getTranscript('one')
    expect(t.id).toBe('one')
    expect(t.title).toBe('A session')
    expect(t.cwd).toBe('/repo/one')
    expect(t.entries.map((e) => e.role)).toEqual(['user', 'assistant'])
  })

  test('getTranscript throws a clear message for an unknown id', async () => {
    const { index } = indexOver({ '/projects/a/one.jsonl': sessionFile() })
    await expect(index.getTranscript('missing')).rejects.toThrow(/Unknown session: missing/)
  })

  test('getTranscript throws when the file vanished between list and read', async () => {
    const { index, readFile } = indexOver({ '/projects/a/one.jsonl': sessionFile() })
    await index.list()
    // Simulate the file being deleted after the index was built.
    readFile.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(index.getTranscript('one')).rejects.toThrow(/no longer available|one/)
  })

  test('a missing projects directory yields an empty list (default readDir contract)', async () => {
    const index = createSessionIndex({
      projectsDir: '/does/not/exist',
      readDir: async () => [],
      readFile: async () => ''
    })
    expect(await index.list()).toEqual([])
  })
})
