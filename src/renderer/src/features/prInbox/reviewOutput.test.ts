import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appendReviewOutput,
  dropReviewOutput,
  MAX_BUFFERED_CHARS,
  onReviewOutput,
  readReviewOutput,
  resetReviewOutput
} from './reviewOutput'

describe('review output buffers', () => {
  beforeEach(() => {
    resetReviewOutput()
  })

  test('each session keeps its own stream', () => {
    appendReviewOutput('rs-1', 'first ')
    appendReviewOutput('rs-2', 'second')
    appendReviewOutput('rs-1', 'again')

    expect(readReviewOutput('rs-1').text).toBe('first again')
    expect(readReviewOutput('rs-2').text).toBe('second')
  })

  test('an unknown session reads as empty rather than throwing', () => {
    expect(readReviewOutput('never-started')).toEqual({ text: '', written: 0 })
  })

  test('a listener receives only its own session, and only what follows it', () => {
    appendReviewOutput('rs-1', 'before')
    const seen: string[] = []
    const off = onReviewOutput('rs-1', (data) => seen.push(data))

    appendReviewOutput('rs-1', 'after')
    appendReviewOutput('rs-2', 'elsewhere')

    expect(seen).toEqual(['after'])
    off()
    appendReviewOutput('rs-1', 'ignored')
    expect(seen).toEqual(['after'])
  })

  test('the buffer keeps a bounded tail, so a long review cannot grow without limit', () => {
    appendReviewOutput('rs-1', 'x'.repeat(MAX_BUFFERED_CHARS))
    appendReviewOutput('rs-1', 'TAIL')

    const { text } = readReviewOutput('rs-1')
    expect(text).toHaveLength(MAX_BUFFERED_CHARS)
    expect(text.endsWith('TAIL')).toBe(true)
    expect(text.startsWith('x')).toBe(true)
  })

  test('the cursor counts everything ever written, so a trim cannot rewind it', () => {
    // A cursor taken from the buffer's length would go backwards here, and a terminal comparing
    // against it would replay the whole tail it had already rendered.
    appendReviewOutput('rs-1', 'y'.repeat(MAX_BUFFERED_CHARS))
    const beforeTrim = readReviewOutput('rs-1').written
    appendReviewOutput('rs-1', 'more')

    const after = readReviewOutput('rs-1')
    expect(beforeTrim).toBe(MAX_BUFFERED_CHARS)
    expect(after.written).toBe(MAX_BUFFERED_CHARS + 4)
    expect(after.text.length).toBeLessThan(after.written)
  })

  test('dropping a finished session releases its buffer and its listeners', () => {
    const listener = vi.fn()
    onReviewOutput('rs-1', listener)
    appendReviewOutput('rs-1', 'output')

    dropReviewOutput('rs-1')

    expect(readReviewOutput('rs-1')).toEqual({ text: '', written: 0 })
    appendReviewOutput('rs-1', 'restarted')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
