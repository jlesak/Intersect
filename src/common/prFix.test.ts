import { describe, expect, test } from 'vitest'
import type { PrThread, PullRequest } from './domain'
import { selectFixThreads } from './prFix'

type Author = Pick<PullRequest, 'role' | 'authorId' | 'authorName'>

const mine: Author = { role: 'author', authorId: 'me-id', authorName: 'Jan Lesak' }

const comment = (
  authorName: string,
  authorId?: string
): PrThread['comments'][number] => ({
  authorName,
  ...(authorId !== undefined ? { authorId } : {}),
  body: 'text',
  publishedAt: 0
})

const thread = (over: Partial<PrThread> = {}): PrThread => ({
  threadId: 1,
  filePath: '/src/a.ts',
  line: 4,
  status: 'active',
  isSystem: false,
  comments: [comment('Marek Kral', 'marek-id')],
  ...over
})

const ids = (threads: PrThread[]): number[] => threads.map((t) => t.threadId)

describe('selectFixThreads', () => {
  test('a reviewer comment on a file line of my pull request qualifies', () => {
    expect(ids(selectFixThreads(mine, [thread()]))).toEqual([1])
  })

  test('a pull request I only review has nothing for me to fix', () => {
    expect(selectFixThreads({ ...mine, role: 'reviewer' }, [thread()])).toEqual([])
  })

  test('only threads anchored to a file line count', () => {
    const threads = [
      thread({ threadId: 1 }),
      thread({ threadId: 2, filePath: null, line: null }),
      thread({ threadId: 3, line: null }),
      thread({ threadId: 4, line: null, removedLine: null })
    ]
    expect(ids(selectFixThreads(mine, threads))).toEqual([1])
  })

  test('a thread on a removed line counts', () => {
    expect(ids(selectFixThreads(mine, [thread({ line: null, removedLine: 7 })]))).toEqual([1])
  })

  test('Active and Pending count; Fixed, Closed, Won’t fix and By design do not', () => {
    const statuses = ['active', 'pending', 'fixed', 'closed', 'wontFix', 'byDesign']
    const threads = statuses.map((status, i) => thread({ threadId: i + 1, status }))
    expect(ids(selectFixThreads(mine, threads))).toEqual([1, 2])
  })

  test('system threads never count', () => {
    expect(selectFixThreads(mine, [thread({ isSystem: true })])).toEqual([])
  })

  test('a thread holding only my own comments does not count', () => {
    const threads = [
      thread({ threadId: 1, comments: [comment('Jan Lesak', 'me-id')] }),
      thread({ threadId: 2, comments: [comment('Jan Lesak', 'me-id'), comment('Marek', 'm')] })
    ]
    expect(ids(selectFixThreads(mine, threads))).toEqual([2])
  })

  test('the identity id decides over the display name when both sides carry one', () => {
    const threads = [
      // My id under a renamed display name is still me.
      thread({ threadId: 1, comments: [comment('Jan L. (old name)', 'ME-ID')] }),
      // Someone else who shares my display name is not me.
      thread({ threadId: 2, comments: [comment('Jan Lesak', 'other-id')] })
    ]
    expect(ids(selectFixThreads(mine, threads))).toEqual([2])
  })

  test('without ids the trimmed, case-folded display name decides', () => {
    const threads = [
      thread({ threadId: 1, comments: [comment('  jan lesak ')] }),
      thread({ threadId: 2, comments: [comment('Marek Kral')] })
    ]
    expect(ids(selectFixThreads(mine, threads))).toEqual([2])
    expect(ids(selectFixThreads({ ...mine, authorId: '' }, [thread()]))).toEqual([1])
  })
})
