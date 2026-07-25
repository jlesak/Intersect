import { render } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { createStore } from './createStore'

interface Item {
  id: string
  done: boolean
}

interface ProbeState {
  byId: Record<string, Item>
  order: string[]
  syncing: boolean
}

const useProbeStore = createStore<ProbeState>()(() => ({
  byId: { a: { id: 'a', done: false }, b: { id: 'b', done: true } },
  order: ['a', 'b'],
  syncing: false
}))

const INITIAL = useProbeStore.getState()

/** A fresh array every call - the shape that makes the snapshot unstable. */
const selectItems = (s: ProbeState): Item[] => s.order.map((id) => s.byId[id])

/** Fresh arrays nested inside a fresh object - one level of shallow comparison cannot reach them. */
const selectByStatus = (s: ProbeState): { done: Item[]; open: Item[] } => ({
  done: selectItems(s).filter((i) => i.done),
  open: selectItems(s).filter((i) => !i.done)
})

let caught: unknown

/** Keeps a render failure out of the test runner so the thrown value can be inspected. */
class Catcher extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    caught = error
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

describe('createStore', () => {
  let consoleError: MockInstance
  let logged: unknown[][]

  beforeEach(() => {
    caught = undefined
    logged = []
    consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    useProbeStore.setState(INITIAL, true)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  test('the guard is active in this environment', () => {
    expect(import.meta.env.DEV).toBe(true)
  })

  test('the full store API survives the wrapper', () => {
    expect(useProbeStore.getInitialState().order).toEqual(['a', 'b'])
    const seen: boolean[] = []
    const unsubscribe = useProbeStore.subscribe((s) => seen.push(s.syncing))
    useProbeStore.setState({ syncing: true })
    unsubscribe()
    useProbeStore.setState({ syncing: false })
    expect(seen).toEqual([true])
    expect(useProbeStore.getState().syncing).toBe(false)
  })

  test('a selectorless read returns the whole state', () => {
    function Probe() {
      return <span className="ix-probe">{useProbeStore().order.join(',')}</span>
    }
    render(<Probe />)
    expect(document.querySelector('.ix-probe')?.textContent).toBe('a,b')
  })

  test('a selector returning a slice as-is is accepted', () => {
    function Probe() {
      return <span className="ix-probe">{useProbeStore((s) => s.order).join(',')}</span>
    }
    render(<Probe />)
    expect(document.querySelector('.ix-probe')?.textContent).toBe('a,b')
    expect(caught).toBeUndefined()
  })

  test('a selector that allocates internally but answers with a primitive is accepted', () => {
    function Probe() {
      return <span className="ix-probe">{useProbeStore((s) => selectItems(s).length)}</span>
    }
    render(<Probe />)
    expect(document.querySelector('.ix-probe')?.textContent).toBe('2')
    expect(caught).toBeUndefined()
  })

  test('a selector building a fresh array is rejected, naming the store and the selector', () => {
    function Probe() {
      return <span>{useProbeStore(selectItems).length}</span>
    }
    render(
      <Catcher>
        <Probe />
      </Catcher>
    )

    const message = messageOf(caught)
    expect(message).toContain('Unstable selector')
    expect(message).toContain('shared/store/createStore.test.tsx')
    expect(message).toContain('s.order.map')
    expect(message).toContain('useShallow')
  })

  test('useShallow stabilises a flat fresh array, so the guard accepts it', () => {
    function Probe() {
      return <span className="ix-probe">{useProbeStore(useShallow(selectItems)).length}</span>
    }
    render(
      <Catcher>
        <Probe />
      </Catcher>
    )

    expect(caught).toBeUndefined()
    expect(document.querySelector('.ix-probe')?.textContent).toBe('2')
  })

  test('useShallow cannot stabilise nested collections, and the guard still rejects them', () => {
    function Probe() {
      return <span>{useProbeStore(useShallow(selectByStatus)).done.length}</span>
    }
    render(
      <Catcher>
        <Probe />
      </Catcher>
    )

    const message = messageOf(caught)
    expect(message).toContain('Unstable selector')
    expect(message).toContain('useMemo')
  })

  test('the same offending selector is logged once, however often it is rendered', () => {
    function Probe() {
      return <span>{useProbeStore((s) => ({ ids: s.order.slice() })).ids.length}</span>
    }
    const tree = (
      <Catcher>
        <Probe />
      </Catcher>
    )
    render(tree)
    render(tree)

    const ours = logged.filter(
      (args) => typeof args[0] === 'string' && args[0].startsWith('Unstable selector')
    )
    expect(ours).toHaveLength(1)
    expect(messageOf(caught)).toContain('Unstable selector')
  })
})
