import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionSummary } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import {
  defaultDateRange,
  formatDuration,
  selectFiltered,
  selectFolders,
  useSessionsStore
} from './store'

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  filePath: `/p/${id}.jsonl`,
  cwd: `/home/me/${id}`,
  folderName: id,
  title: `Session ${id}`,
  gitBranch: null,
  firstTimestamp: 0,
  lastTimestamp: 1000,
  durationMs: 1000,
  activeDurationMs: 1000,
  messageCount: 2,
  userPrompts: [],
  ...over
})

const mocked = vi.mocked(api)

const reset = (over: Partial<ReturnType<typeof useSessionsStore.getState>> = {}): void => {
  useSessionsStore.setState(
    {
      status: 'idle',
      error: null,
      all: [],
      query: '',
      from: null,
      to: null,
      folders: null,
      selectedId: null,
      transcript: null,
      transcriptStatus: 'idle',
      pendingResume: null,
      ...over
    },
    false
  )
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('selectFiltered', () => {
  const all: SessionSummary[] = [
    summary('a', {
      title: 'Lock owner on reservation card',
      folderName: 'SPOT',
      lastTimestamp: 3000,
      userPrompts: ['show the lock owner of a locked reservation']
    }),
    summary('b', {
      title: 'Refactor absence validation',
      folderName: 'Attendance',
      lastTimestamp: 2000,
      userPrompts: ['where is the owner of the lock held']
    }),
    summary('c', {
      title: 'Attention notifications',
      folderName: 'Intersect',
      lastTimestamp: 1000,
      userPrompts: ['tab shows session status']
    })
  ]

  test('matches query against title and user prompts, case-insensitively', () => {
    const s = { ...useSessionsStore.getState(), all, query: 'LOCK OWNER' }
    // "a" matches on both title and prompt; "b" matches "owner ... lock" only via prompt substring
    // check ("lock owner" is not a substring of b's prompt), so only "a" qualifies.
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['a'])
  })

  test('query matching a prompt but not the title still selects the session', () => {
    const s = { ...useSessionsStore.getState(), all, query: 'session status' }
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['c'])
  })

  test('date range filters on lastTimestamp inclusively', () => {
    const s = { ...useSessionsStore.getState(), all, from: 1500, to: 2500 }
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['b'])
  })

  test('folder multiselect keeps only the chosen folders', () => {
    const s = { ...useSessionsStore.getState(), all, folders: ['SPOT', 'Intersect'] }
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['a', 'c'])
  })

  test('null folders means every folder', () => {
    const s = { ...useSessionsStore.getState(), all, folders: null }
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  test('combines text, date range and folder filters and preserves descending order', () => {
    const s = {
      ...useSessionsStore.getState(),
      all,
      query: 'owner',
      from: 1500,
      to: 3500,
      folders: ['SPOT', 'Attendance']
    }
    expect(selectFiltered(s).map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('selectFolders', () => {
  test('returns distinct folderNames sorted', () => {
    const s = {
      ...useSessionsStore.getState(),
      all: [
        summary('1', { folderName: 'Zeta' }),
        summary('2', { folderName: 'Alpha' }),
        summary('3', { folderName: 'Zeta' })
      ]
    }
    expect(selectFolders(s)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('defaultDateRange', () => {
  test('spans the last 7 days inclusive: end of today back to start of six days ago', () => {
    const { from, to } = defaultDateRange()
    expect(to).toBeGreaterThan(from)
    const days = (to - from) / (24 * 60 * 60 * 1000)
    // Six full days plus almost all of today -> just under 7 days.
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7)
    // `to` is the end of today, so "now" falls within the range.
    expect(to).toBeGreaterThanOrEqual(Date.now())
  })
})

describe('formatDuration', () => {
  test.each([
    [0, '<1m'],
    [59_000, '<1m'],
    [48 * 60_000, '48m'],
    [(3 * 60 + 12) * 60_000, '3h 12m']
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('toggleFolder', () => {
  beforeEach(() => {
    reset({ all: [summary('SPOT', { folderName: 'SPOT' }), summary('Int', { folderName: 'Int' })] })
  })

  test('toggling one folder off from the all state selects the rest', () => {
    useSessionsStore.getState().toggleFolder('SPOT')
    expect(useSessionsStore.getState().folders).toEqual(['Int'])
  })

  test('re-selecting every folder collapses back to null', () => {
    useSessionsStore.getState().toggleFolder('SPOT') // -> ['Int']
    useSessionsStore.getState().toggleFolder('SPOT') // -> all again
    expect(useSessionsStore.getState().folders).toBeNull()
  })
})

describe('store status transitions', () => {
  test('hydrate loads sessions and is ready', async () => {
    mocked.list.mockResolvedValue([summary('a'), summary('b')])
    await useSessionsStore.getState().hydrate()
    const s = useSessionsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.all.map((x) => x.id)).toEqual(['a', 'b'])
  })

  test('hydrate sets error status when the IPC call fails', async () => {
    mocked.list.mockRejectedValue(new Error('index gone'))
    await useSessionsStore.getState().hydrate()
    expect(useSessionsStore.getState().status).toBe('error')
    expect(useSessionsStore.getState().error).toMatch(/index gone/)
  })

  test('refresh replaces the list', async () => {
    reset({ status: 'ready', all: [summary('old')] })
    mocked.refresh.mockResolvedValue([summary('fresh')])
    await useSessionsStore.getState().refresh()
    const s = useSessionsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.all.map((x) => x.id)).toEqual(['fresh'])
  })

  test('select loads the transcript for the id', async () => {
    mocked.getTranscript.mockResolvedValue({
      id: 'a',
      title: 'Session a',
      cwd: '/home/me/a',
      entries: []
    })
    await useSessionsStore.getState().select('a')
    const s = useSessionsStore.getState()
    expect(s.selectedId).toBe('a')
    expect(s.transcriptStatus).toBe('ready')
    expect(s.transcript?.id).toBe('a')
    expect(mocked.getTranscript).toHaveBeenCalledWith('a')
  })

  test('requestResume records the intent and clearResume drops it', () => {
    const a = summary('a')
    useSessionsStore.getState().requestResume(a)
    expect(useSessionsStore.getState().pendingResume?.id).toBe('a')
    useSessionsStore.getState().clearResume()
    expect(useSessionsStore.getState().pendingResume).toBeNull()
  })
})
