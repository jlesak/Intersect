import { describe, expect, test } from 'vitest'
import { createCloneQueue } from './worktreeManager'

/**
 * Two reviews starting at once on one clone would otherwise run `git fetch` and `git worktree add`
 * concurrently in the same repository, which fails on its index and ref locks. The queue is what
 * makes that impossible, so its ordering is pinned here rather than left to a timing-dependent
 * integration test.
 */
describe('the per-clone queue', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => {}
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  test('work on one clone never overlaps', async () => {
    const onClone = createCloneQueue()
    const events: string[] = []
    const first = deferred()

    const a = onClone('/repo', async () => {
      events.push('a:start')
      await first.promise
      events.push('a:end')
    })
    const b = onClone('/repo', async () => {
      events.push('b:start')
    })

    // The second job has not begun while the first is still in flight.
    await Promise.resolve()
    expect(events).toEqual(['a:start'])

    first.resolve()
    await Promise.all([a, b])
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  test('work on different clones runs in parallel', async () => {
    const onClone = createCloneQueue()
    const events: string[] = []
    const held = deferred()

    const a = onClone('/repo-a', async () => {
      events.push('a:start')
      await held.promise
    })
    const b = onClone('/repo-b', async () => {
      events.push('b:start')
    })

    await b
    expect(events).toEqual(['a:start', 'b:start'])
    held.resolve()
    await a
  })

  test('a failed job releases the queue instead of stalling every later review', async () => {
    const onClone = createCloneQueue()

    await expect(
      onClone('/repo', () => Promise.reject(new Error('fetch failed')))
    ).rejects.toThrow(/fetch failed/)

    await expect(onClone('/repo', async () => 'went through')).resolves.toBe('went through')
  })

  test('the caller sees its own result, not the previous job’s', async () => {
    const onClone = createCloneQueue()

    const [first, second] = await Promise.all([
      onClone('/repo', async () => 'first'),
      onClone('/repo', async () => 'second')
    ])

    expect([first, second]).toEqual(['first', 'second'])
  })
})
