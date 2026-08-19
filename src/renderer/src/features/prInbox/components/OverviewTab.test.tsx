import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PrThread, PullRequest } from '@common/domain'
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

/**
 * A realistic thread set, deliberately with the resolved thread listed first by the server: one
 * fixed, two unresolved, and one ADO housekeeping thread.
 */
const THREADS = [
  thread(3, {
    status: 'fixed',
    comments: [{ authorName: 'Marek Kral', body: 'Already handled last push.', publishedAt: 0 }]
  }),
  thread(1),
  thread(2, { filePath: null, line: null, comments: [{ authorName: 'Jan Lesak', body: 'Ship it.', publishedAt: 2 }] }),
  thread(4, { isSystem: true, status: 'closed' })
]

const rendered = (): string[] =>
  [...document.querySelectorAll('[data-testid="pr-thread"]')].map(
    (el) => el.querySelector('.ix-thread__body')?.textContent ?? ''
  )

const resolvedSection = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.ix-overview__resolved')

/**
 * The PR Overview comment list, mounted client-side. Static markup cannot expose a re-render loop,
 * so only a real root exercises how the tab subscribes to the threads.
 */
describe('OverviewTab', () => {
  const loadThreads = usePrInboxStore.getState().loadThreads

  afterEach(() => {
    usePrInboxStore.setState({ threads: [], threadsLoaded: false, threadsError: null, loadThreads })
  })

  test('mounts and settles without a render loop', async () => {
    usePrInboxStore.setState({ threads: THREADS, threadsLoaded: true })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<OverviewTab />)
      })

      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })

  test('the threads still asking for something come first; ADO housekeeping never shows', async () => {
    usePrInboxStore.setState({ threads: THREADS, threadsLoaded: true })

    await act(async () => {
      render(<OverviewTab />)
    })
    // Read with the settled section open, so the assertion spans every thread the page holds. A
    // collapsed list would look the same whether the resolved thread had been sorted to the bottom
    // or merely filtered out, and could not tell the two apart.
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="pr-resolved-toggle"]')!)
    })

    // The server listed the resolved thread first; it is not what the reviewer owes anything on, so
    // it sinks below the two that are.
    expect(rendered()).toEqual([
      'This retry loop can spin forever.',
      'Ship it.',
      'Already handled last push.'
    ])
    expect(document.body.textContent).not.toContain('Policy status')
  })

  test('resolved threads are a dimmed section that says how many it holds', async () => {
    usePrInboxStore.setState({ threads: THREADS, threadsLoaded: true })

    await act(async () => {
      render(<OverviewTab />)
    })

    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="pr-resolved-toggle"]')!
    expect(toggle.textContent).toContain('1')
    // Collapsed, so the resolved thread is out of the way but its existence is not hidden.
    expect(rendered()).toHaveLength(2)

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(rendered()).toHaveLength(3)
    const section = resolvedSection()!
    expect(section.querySelectorAll('[data-testid="pr-thread"]')).toHaveLength(1)
  })

  test('a PR nobody has commented on offers no resolved section at all', async () => {
    usePrInboxStore.setState({ threads: [], threadsLoaded: true })

    await act(async () => {
      render(<OverviewTab />)
    })

    expect(document.querySelector('[data-testid="pr-resolved-toggle"]')).toBeNull()
    expect(document.querySelector('.ix-empty__title')).not.toBeNull()
  })

  test('a conversation that could not be read is never reported as no conversation', async () => {
    // An expired token or a dropped VPN must not have the app assert that a colleague's review does
    // not exist.
    usePrInboxStore.setState({
      threads: [],
      threadsLoaded: false,
      threadsError: 'TF400813: the token has expired'
    })

    await act(async () => {
      render(<OverviewTab />)
    })

    expect(document.body.textContent).not.toContain('Nobody has commented')
    expect(document.body.textContent).toContain('TF400813')
  })

  test('the failed conversation offers a retry that fetches again', async () => {
    const retried = vi.fn(async () => {})
    usePrInboxStore.setState({
      threads: [],
      threadsLoaded: false,
      threadsError: 'offline',
      loadThreads: retried
    })

    await act(async () => {
      render(<OverviewTab />)
    })
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="pr-threads-retry"]')!)
    })

    // Nothing else recovers this: the tabs are pure setters, so without the retry the failure is
    // final for as long as the PR stays open.
    expect(retried).toHaveBeenCalledOnce()
  })

  test('a PR whose every thread is resolved says so instead of claiming nothing was said', async () => {
    usePrInboxStore.setState({ threads: [thread(3, { status: 'fixed' })], threadsLoaded: true })

    await act(async () => {
      render(<OverviewTab />)
    })

    expect(document.querySelector('.ix-empty__title')).toBeNull()
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="pr-resolved-toggle"]')!.textContent
    ).toContain('1')
  })
})

function pullRequest(description: string): PullRequest {
  return {
    prId: 1,
    repositoryId: 'repo-1',
    repositoryName: 'intersect-app',
    projectId: 'SPOT',
    title: 'Add rate limiting',
    description,
    authorId: 'u1',
    authorName: 'Jan Lesak',
    createdAt: 0,
    status: 'active',
    sourceRefName: 'refs/heads/feature/rate-limit',
    targetRefName: 'refs/heads/main',
    sourceCommitId: 'a',
    targetCommitId: 'b',
    url: 'https://devops/pr/1',
    role: 'reviewer',
    myVote: null,
    myReviewerId: null,
    reviewers: [],
    newChangesSinceMyReview: false,
    activeThreadCount: 0,
    lastActivityAt: 0
  }
}

const seedPr = async (description: string): Promise<void> => {
  usePrInboxStore.setState({
    prsByKey: { 'repo-1:1': pullRequest(description) },
    order: ['repo-1:1'],
    selectedKey: 'repo-1:1',
    threads: [],
    threadsLoaded: true
  })
  await act(async () => {
    render(<OverviewTab />)
  })
}

const description = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="pr-description"]')

describe('OverviewTab description', () => {
  afterEach(() => {
    usePrInboxStore.setState({ prsByKey: {}, order: [], selectedKey: null, threads: [] })
  })

  test('leads with what the author wrote, keeping their line breaks', async () => {
    await seedPr('Adds a token bucket.\n\n- caps bursts\n- keeps the queue drained')

    // The author's own line breaks reach the DOM intact; that they survive to the screen is the
    // stylesheet's job, and the end-to-end suite reads the computed style in a real browser.
    expect(description()!.textContent).toBe(
      'Adds a token bucket.\n\n- caps bursts\n- keeps the queue drained'
    )
  })

  test('an undescribed PR gets no box at all rather than an empty one', async () => {
    await seedPr('')

    expect(description()).toBeNull()
  })

  test('a description of nothing but whitespace is treated as none', async () => {
    await seedPr('   \n\n  ')

    expect(description()).toBeNull()
  })

  test('markup a colleague wrote reaches the screen as characters, never as elements', async () => {
    // Descriptions are written by other people on a remote server. They are shown as the text they
    // are; nothing in them is ever allowed to become part of this page.
    await seedPr('<img src=x onerror="alert(1)"> **bold** <b>hi</b>')

    expect(description()!.querySelector('img')).toBeNull()
    expect(description()!.querySelector('b')).toBeNull()
    expect(description()!.textContent).toBe('<img src=x onerror="alert(1)"> **bold** <b>hi</b>')
  })
})
