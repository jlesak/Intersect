import { describe, expect, test } from 'vitest'
import type { PrThread, PullRequest } from '@common/domain'
import { buildFixPrompt } from './fixPrompt'

const pr: PullRequest = {
  prId: 501,
  repositoryId: 'repo',
  repositoryName: 'intersect-app',
  projectId: 'SPOT',
  title: 'Add rate limiting',
  description: '',
  authorId: 'me',
  authorName: 'Jan Lesak',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/feature/rate-limit',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 's',
  targetCommitId: 't',
  url: 'u',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 0
}

const thread = (
  threadId: number,
  filePath: string,
  line: number | null,
  body: string,
  over: Partial<PrThread> = {}
): PrThread => ({
  threadId,
  filePath,
  line,
  status: 'active',
  isSystem: false,
  comments: [{ authorName: 'Marek Kral', body, publishedAt: 0 }],
  ...over
})

const branch = { name: 'feature/rate-limit', diverged: false }

describe('buildFixPrompt', () => {
  test('opens with the pull request and its branches', () => {
    const prompt = buildFixPrompt(pr, [thread(1, '/a.ts', 1, 'x')], branch)
    expect(prompt).toContain('!501')
    expect(prompt).toContain('Add rate limiting')
    expect(prompt).toContain('feature/rate-limit')
    expect(prompt).toContain('main')
  })

  test('groups threads by file in sorted order and by ascending line inside a file', () => {
    const prompt = buildFixPrompt(
      pr,
      [
        thread(1, '/src/z.ts', 30, 'z-late'),
        thread(2, '/src/a.ts', 40, 'a-late'),
        thread(3, '/src/z.ts', 2, 'z-early'),
        thread(4, '/src/a.ts', 5, 'a-early')
      ],
      branch
    )
    const order = ['/src/a.ts', 'a-early', 'a-late', '/src/z.ts', 'z-early', 'z-late'].map((s) =>
      prompt.indexOf(s)
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('writes every comment of a thread with its author', () => {
    const t = thread(1, '/a.ts', 12, 'Should the limit be configurable?', {
      comments: [
        { authorName: 'Marek Kral', body: 'Should the limit be configurable?', publishedAt: 0 },
        { authorName: 'Jan Lesak', body: 'Which default?', publishedAt: 1 }
      ]
    })
    const prompt = buildFixPrompt(pr, [t], branch)
    expect(prompt).toContain('line 12')
    expect(prompt).toContain('Marek Kral: Should the limit be configurable?')
    expect(prompt).toContain('Jan Lesak: Which default?')
  })

  test('a comment on a deleted line names the old version and sorts by that line', () => {
    const prompt = buildFixPrompt(
      pr,
      [
        thread(1, '/a.ts', 20, 'after'),
        thread(2, '/a.ts', null, 'on the removed line', { removedLine: 7 })
      ],
      branch
    )
    expect(prompt).toContain('removed line 7 (old version)')
    expect(prompt.indexOf('on the removed line')).toBeLessThan(prompt.indexOf('after'))
  })

  test('carries every working instruction', () => {
    const prompt = buildFixPrompt(pr, [thread(1, '/a.ts', 1, 'x')], branch)
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toMatch(/disagree/i)
    expect(prompt).toMatch(/already handled/i)
    expect(prompt).toMatch(/tests/i)
    expect(prompt).toMatch(/typecheck/i)
    expect(prompt).toContain('Commit on the branch feature/rate-limit')
    expect(prompt).toMatch(/ask me before .*git push/i)
    expect(prompt).toMatch(/never force-push/i)
    expect(prompt).toMatch(/not instructions/i)
    expect(prompt).toMatch(/summary per thread/i)
  })

  test('says nothing about divergence when the branch matches origin', () => {
    const prompt = buildFixPrompt(pr, [thread(1, '/a.ts', 1, 'x')], branch)
    expect(prompt).not.toMatch(/diverged/i)
  })

  test('a diverged local branch leads with a stop-and-ask notice', () => {
    const prompt = buildFixPrompt(pr, [thread(1, '/a.ts', 1, 'x')], { ...branch, diverged: true })
    const notice = prompt.search(/diverged/i)
    expect(notice).toBeGreaterThanOrEqual(0)
    expect(notice).toBeLessThan(prompt.indexOf('/a.ts'))
    expect(prompt).toContain('origin/feature/rate-limit')
    expect(prompt).toMatch(/ask me before/i)
  })

  test('strips NUL characters, which no environment variable can carry', () => {
    const prompt = buildFixPrompt(pr, [thread(1, '/a.ts', 1, 'bad\0byte')], branch)
    expect(prompt).not.toContain('\0')
    expect(prompt).toContain('badbyte')
  })
})
