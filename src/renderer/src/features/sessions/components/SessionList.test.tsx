import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionSummary } from '@common/domain'
import { useSessionsStore } from '../store'
import { SessionList } from './SessionList'

const HOUR = 3_600_000

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  const last = Date.now() - HOUR
  return {
    id: 's1',
    filePath: '/home/jan/.claude/projects/-repos-spot/s1.jsonl',
    cwd: '/repos/spot',
    folderName: 'spot',
    title: 'Fix the sync',
    gitBranch: 'main',
    firstTimestamp: last - HOUR,
    lastTimestamp: last,
    durationMs: HOUR,
    activeDurationMs: HOUR / 2,
    messageCount: 12,
    userPrompts: ['make the sync idempotent'],
    ...over
  }
}

/**
 * The filtered session list, mounted client-side. Static markup cannot expose a re-render loop, so
 * only a real root exercises how the list subscribes to the filtered sessions.
 */
describe('SessionList', () => {
  afterEach(() => {
    useSessionsStore.setState({
      status: 'idle',
      error: null,
      all: [],
      query: '',
      folders: null,
      selectedId: null
    })
  })

  test('mounts and settles without a render loop', async () => {
    useSessionsStore.setState({
      status: 'ready',
      error: null,
      all: [
        session(),
        session({ id: 's2', folderName: 'intersect', cwd: '/repos/intersect', title: 'Add the radar' }),
        session({ id: 's3', folderName: 'spot', title: 'Rework the importer' })
      ],
      query: '',
      folders: null,
      selectedId: 's2'
    })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<SessionList />)
      })

      expect(logged).toEqual([])
      const titles = [...document.querySelectorAll('.ix-session-row__title')].map((e) => e.textContent)
      expect(titles).toEqual(['Fix the sync', 'Add the radar', 'Rework the importer'])
      expect(document.querySelectorAll('.ix-session-row--active')).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('narrowing the filters re-renders the subscribed list', async () => {
    useSessionsStore.setState({
      status: 'ready',
      error: null,
      all: [
        session(),
        session({ id: 's2', folderName: 'intersect', title: 'Add the radar' })
      ],
      query: '',
      folders: null
    })

    await act(async () => {
      render(<SessionList />)
    })
    await act(async () => {
      useSessionsStore.getState().setFolders(['intersect'])
    })

    const titles = [...document.querySelectorAll('.ix-session-row__title')].map((e) => e.textContent)
    expect(titles).toEqual(['Add the radar'])
  })
})
