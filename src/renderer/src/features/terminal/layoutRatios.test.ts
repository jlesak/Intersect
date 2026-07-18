import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { equalShares } from '@common/terminalLayoutShares'
import { SAVE_DELAY_MS, useLayoutRatiosStore } from './layoutRatios'
import * as api from './ipc'

vi.mock('./ipc', () => ({
  getTerminalLayouts: vi.fn(async () => ({})),
  setTerminalLayout: vi.fn(async () => undefined)
}))

const getLayouts = vi.mocked(api.getTerminalLayouts)
const setLayout = vi.mocked(api.setTerminalLayout)

const initial = useLayoutRatiosStore.getState()

describe('layout ratios store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useLayoutRatiosStore.setState(initial, true)
    getLayouts.mockClear()
    getLayouts.mockResolvedValue({})
    setLayout.mockClear()
  })

  afterEach(() => {
    // Nothing scheduled in one test may leak a write into the next.
    useLayoutRatiosStore.getState().flush()
    setLayout.mockClear()
    vi.useRealTimers()
  })

  test('hydrate loads and normalizes the persisted shares for the project', async () => {
    getLayouts.mockResolvedValue({ columns: [70, 30], grid: 'corrupt' as never })
    await useLayoutRatiosStore.getState().hydrate('p1')
    const s = useLayoutRatiosStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.columns).toEqual([70, 30])
    expect(s.rows).toEqual([50, 50])
    expect(s.grid).toEqual(equalShares('grid'))
  })

  test('a failed load falls back to equal shares instead of blocking the stage', async () => {
    getLayouts.mockRejectedValue(new Error('core down'))
    await useLayoutRatiosStore.getState().hydrate('p1')
    const s = useLayoutRatiosStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.columns).toEqual([50, 50])
  })

  test('hydrating the already loaded project does not refetch', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    await useLayoutRatiosStore.getState().hydrate('p1')
    expect(getLayouts).toHaveBeenCalledTimes(1)
  })

  test('preview debounces the write and collapses a drag into one save', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('columns', [60, 40])
    useLayoutRatiosStore.getState().preview('columns', [65, 35])
    useLayoutRatiosStore.getState().preview('columns', [70, 30])
    expect(setLayout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(setLayout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(setLayout).toHaveBeenCalledTimes(1)
    expect(setLayout).toHaveBeenCalledWith('p1', 'columns', [70, 30])
  })

  test('preview skips the mount echo: an unchanged value never schedules a write', async () => {
    getLayouts.mockResolvedValue({ columns: [70, 30] })
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('columns', [70.001, 29.999])
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(setLayout).not.toHaveBeenCalled()
  })

  test('commit persists immediately (pointer released, resize key pressed)', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('rows', [55, 45])
    useLayoutRatiosStore.getState().commit('rows', [60, 40])
    expect(setLayout).toHaveBeenCalledTimes(1)
    expect(setLayout).toHaveBeenCalledWith('p1', 'rows', [60, 40])
    expect(useLayoutRatiosStore.getState().rows).toEqual([60, 40])
  })

  test('window blur flushes a pending write', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('columns', [61, 39])
    window.dispatchEvent(new Event('blur'))
    expect(setLayout).toHaveBeenCalledWith('p1', 'columns', [61, 39])
  })

  test('window close (beforeunload) flushes a pending write', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('columns', [62, 38])
    window.dispatchEvent(new Event('beforeunload'))
    expect(setLayout).toHaveBeenCalledWith('p1', 'columns', [62, 38])
  })

  test('flush writes a pending value at once (layout switch boundary)', async () => {
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('grid', {
      columns: [70, 30],
      leftRows: [50, 50],
      rightRows: [50, 50]
    })
    useLayoutRatiosStore.getState().flush()
    expect(setLayout).toHaveBeenCalledWith('p1', 'grid', {
      columns: [70, 30],
      leftRows: [50, 50],
      rightRows: [50, 50]
    })
  })

  test('switching projects flushes the previous project and isolates its shares', async () => {
    getLayouts.mockImplementation(async (key) =>
      key === 'p1' ? { columns: [70, 30] } : { columns: [20, 80] }
    )
    await useLayoutRatiosStore.getState().hydrate('p1')
    useLayoutRatiosStore.getState().preview('columns', [66, 34])

    await useLayoutRatiosStore.getState().hydrate('p2')
    // The pending p1 write was flushed by the switch, not dropped or re-keyed to p2.
    expect(setLayout).toHaveBeenCalledTimes(1)
    expect(setLayout).toHaveBeenCalledWith('p1', 'columns', [66, 34])
    expect(useLayoutRatiosStore.getState().columns).toEqual([20, 80])
  })

  test('a stale hydrate response never overwrites a newer project', async () => {
    let releaseP1: (v: { columns: [number, number] }) => void = () => {}
    getLayouts.mockImplementation((key) => {
      if (key === 'p1') return new Promise((resolve) => (releaseP1 = resolve))
      return Promise.resolve({ columns: [20, 80] })
    })
    const first = useLayoutRatiosStore.getState().hydrate('p1')
    const second = useLayoutRatiosStore.getState().hydrate('p2')
    await second
    releaseP1({ columns: [70, 30] })
    await first
    const s = useLayoutRatiosStore.getState()
    expect(s.projectKey).toBe('p2')
    expect(s.columns).toEqual([20, 80])
  })

  test('preview before any project is hydrated is ignored', () => {
    useLayoutRatiosStore.getState().preview('columns', [70, 30])
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(setLayout).not.toHaveBeenCalled()
  })
})
