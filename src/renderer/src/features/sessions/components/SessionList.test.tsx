import { act, fireEvent, render } from '@testing-library/react'
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

  test('only the pointed-at row is a Tab stop, and the arrows move it', async () => {
    useSessionsStore.setState({
      status: 'ready',
      all: [session(), session({ id: 's2', title: 'Add the radar' }), session({ id: 's3', title: 'Rework the importer' })],
      query: '',
      folders: null
    })
    await act(async () => {
      render(<SessionList />)
    })
    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-session-row')]
    const tabStops = (): string[] => rows().map((r) => r.getAttribute('tabindex') ?? '')

    expect(tabStops()).toEqual(['0', '-1', '-1'])

    await act(async () => {
      fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })
    })
    expect(tabStops()).toEqual(['-1', '0', '-1'])
    expect(document.activeElement).toBe(rows()[1])

    await act(async () => {
      fireEvent.keyDown(rows()[1], { key: 'End' })
    })
    expect(document.activeElement).toBe(rows()[2])

    // The last row is the end of the list: ArrowDown there must not wrap or run off it.
    await act(async () => {
      fireEvent.keyDown(rows()[2], { key: 'ArrowDown' })
    })
    expect(document.activeElement).toBe(rows()[2])

    await act(async () => {
      fireEvent.keyDown(rows()[2], { key: 'ArrowUp' })
    })
    expect(document.activeElement).toBe(rows()[1])
  })

  test('Enter opens the pointed-at session and Cmd+Enter asks to resume it', async () => {
    useSessionsStore.setState({
      status: 'ready',
      all: [session(), session({ id: 's2', title: 'Add the radar' })],
      query: '',
      folders: null,
      selectedId: null,
      pendingResume: null
    })
    const select = vi.spyOn(useSessionsStore.getState(), 'select').mockResolvedValue()
    try {
      await act(async () => {
        render(<SessionList />)
      })
      const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ix-session-row')]

      await act(async () => {
        fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })
        fireEvent.keyDown(rows()[1], { key: 'Enter' })
      })
      // The second row, not the first: Enter acts on wherever the arrows left the pointer.
      expect(select).toHaveBeenCalledWith('s2')
      expect(useSessionsStore.getState().pendingResume).toBeNull()

      await act(async () => {
        fireEvent.keyDown(rows()[1], { key: 'Enter', metaKey: true })
      })
      expect(useSessionsStore.getState().pendingResume?.id).toBe('s2')
      expect(select).toHaveBeenCalledTimes(1)
    } finally {
      select.mockRestore()
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
