import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionSummary } from '@common/domain'
import { useSessionsStore } from '../store'
import { SessionFilters } from './SessionFilters'

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

/** The three indexed folders the filter bar derives its multiselect from. */
function seedFolders(): void {
  useSessionsStore.setState({
    status: 'ready',
    error: null,
    all: [
      session(),
      session({ id: 's2', folderName: 'intersect', cwd: '/repos/intersect' }),
      session({ id: 's3', folderName: 'atlas', cwd: '/repos/atlas' })
    ],
    query: '',
    folders: null
  })
}

/**
 * The sessions filter bar, mounted client-side. Static markup cannot expose a re-render loop, so
 * only a real root exercises how the folder multiselect subscribes to the indexed folders.
 */
describe('SessionFilters', () => {
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
    seedFolders()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<SessionFilters />)
      })

      expect(logged).toEqual([])
      // The count reads off the derived folder list, so a populated selector is what rendered it.
      expect(document.querySelector('.ix-msel__count')?.textContent).toBe('3/3')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('unticking a folder is written to the store, so the list actually narrows', async () => {
    seedFolders()
    await act(async () => {
      render(<SessionFilters />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="sessions-folders"]')?.click()
    })

    await act(async () => {
      fireEvent.click(screen.getByLabelText('spot'))
    })

    expect(useSessionsStore.getState().folders).toEqual(['atlas', 'intersect'])
  })

  test('ticking the last folder back collapses the selection to "all folders"', async () => {
    seedFolders()
    await act(async () => {
      render(<SessionFilters />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="sessions-folders"]')?.click()
    })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('spot'))
    })

    await act(async () => {
      fireEvent.click(screen.getByLabelText('spot'))
    })

    expect(useSessionsStore.getState().folders).toBeNull()
  })

  test('the open folder popover lists the indexed folders sorted', async () => {
    seedFolders()

    await act(async () => {
      render(<SessionFilters />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="sessions-folders"]')?.click()
    })

    const names = [...document.querySelectorAll('.ix-msel__item span')].map(
      (e) => e.textContent
    )
    expect(names).toEqual(['atlas', 'intersect', 'spot'])
  })
})
