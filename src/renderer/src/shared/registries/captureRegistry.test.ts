import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetCaptureRegistryForTests,
  getCaptures,
  matchCapture,
  registerCapture,
  type Capture
} from './captureRegistry'

const capture = (over: Partial<Capture> = {}): Capture => ({
  prefix: 'todo:',
  hint: 'Add a task',
  preview: (rest) => (rest === '' ? null : `Add task "${rest}"`),
  run: () => {},
  ...over
})

describe('captureRegistry', () => {
  beforeEach(() => __resetCaptureRegistryForTests())

  test('registers a capture and lists it', () => {
    const c = capture()
    registerCapture(c)
    expect(getCaptures()).toEqual([c])
  })

  test('throws when a prefix is claimed twice', () => {
    registerCapture(capture())
    expect(() => registerCapture(capture())).toThrow(/already registered/i)
  })

  test('matches a query on its prefix and hands over the rest', () => {
    registerCapture(capture())
    expect(matchCapture('todo: call the vendor')?.rest).toBe('call the vendor')
  })

  test('a query that is only the prefix matches with nothing to act on', () => {
    registerCapture(capture())
    const matched = matchCapture('todo:')
    expect(matched?.rest).toBe('')
    expect(matched?.capture.preview('')).toBeNull()
  })

  test('the prefix is matched whatever its case', () => {
    registerCapture(capture())
    expect(matchCapture('TODO: x')?.rest).toBe('x')
  })

  test('the rest keeps the case the user typed', () => {
    registerCapture(capture())
    expect(matchCapture('todo: Call Marek')?.rest).toBe('Call Marek')
  })

  test('a query that is not a capture matches nothing', () => {
    registerCapture(capture())
    expect(matchCapture('new shell tab')).toBeNull()
    expect(matchCapture('todo')).toBeNull()
  })

  // Registered shortest-first on purpose: only real longest-prefix matching can pass this, not a
  // first-hit-wins loop that happens to see the specific one first.
  test('the longer of two overlapping prefixes wins, whichever registered first', () => {
    registerCapture(capture({ prefix: '1:' }))
    registerCapture(capture({ prefix: '1:1:' }))
    expect(matchCapture('1:1: Marek')?.capture.prefix).toBe('1:1:')
    expect(matchCapture('1:1: Marek')?.rest).toBe('Marek')
    expect(matchCapture('1: something')?.capture.prefix).toBe('1:')
  })

  test('running a capture passes it the text after the prefix', async () => {
    const run = vi.fn()
    registerCapture(capture({ run }))
    const matched = matchCapture('todo: call the vendor')!
    await matched.capture.run(matched.rest)
    expect(run).toHaveBeenCalledWith('call the vendor')
  })

  test('reset clears the registry', () => {
    registerCapture(capture())
    __resetCaptureRegistryForTests()
    expect(getCaptures()).toEqual([])
  })
})
