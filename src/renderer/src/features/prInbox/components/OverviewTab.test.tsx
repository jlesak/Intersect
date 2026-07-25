import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PrThread } from '@common/domain'
import { usePrInboxStore } from '../store'
import { OverviewTab } from './OverviewTab'

function thread(threadId: number, over: Partial<PrThread> = {}): PrThread {
  return {
    threadId,
    filePath: 'src/core/sync.ts',
    line: 42,
    status: 'active',
    isSystem: false,
    comments: [
      { authorName: 'Eva Novak', body: 'This retry loop can spin forever.', publishedAt: 1 }
    ],
    ...over
  }
}

/** A realistic thread set: two unresolved, one fixed, and one ADO housekeeping thread. */
const THREADS = [
  thread(1),
  thread(2, { filePath: null, line: null, comments: [{ authorName: 'Jan Lesak', body: 'Ship it.', publishedAt: 2 }] }),
  thread(3, { status: 'fixed' }),
  thread(4, { isSystem: true, status: 'closed' })
]

/**
 * The PR Overview comment list, mounted client-side. Static markup cannot expose a re-render loop,
 * so only a real root exercises how the tab subscribes to the filtered threads.
 */
describe('OverviewTab', () => {
  afterEach(() => {
    usePrInboxStore.setState({ threads: [], threadsLoaded: false, threadFilter: 'active' })
  })

  test('mounts and settles without a render loop', async () => {
    usePrInboxStore.setState({ threads: THREADS, threadsLoaded: true, threadFilter: 'active' })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<OverviewTab />)
      })

      expect(logged).toEqual([])
      // The default Active filter hides the fixed thread and the system one.
      expect(document.querySelectorAll('[data-testid="pr-thread"]')).toHaveLength(2)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('switching the filter re-renders the subscribed thread list', async () => {
    usePrInboxStore.setState({ threads: THREADS, threadsLoaded: true, threadFilter: 'active' })

    await act(async () => {
      render(<OverviewTab />)
    })
    await act(async () => {
      usePrInboxStore.getState().setThreadFilter('all')
    })

    // Every non-system thread, resolved included.
    expect(document.querySelectorAll('[data-testid="pr-thread"]')).toHaveLength(3)
  })
})
