import { beforeEach, describe, expect, test } from 'vitest'
import { useFindStore } from './findStore'

const A = 'ws1:tabA'
const B = 'ws1:tabB'

beforeEach(() => {
  useFindStore.setState({ open: {}, query: {}, focusToken: {} })
})

describe('find bar state', () => {
  test('a split layout holds one bar per pane, each with its own query', () => {
    const store = useFindStore.getState()
    store.openFind(A)
    store.setQuery(A, 'error')
    store.setQuery(B, 'warning')

    expect(useFindStore.getState().open[A]).toBe(true)
    expect(useFindStore.getState().open[B]).toBeUndefined()
    expect(useFindStore.getState().query[A]).toBe('error')
    expect(useFindStore.getState().query[B]).toBe('warning')
  })

  test('closing keeps the query, so re-opening offers the last thing searched for', () => {
    const store = useFindStore.getState()
    store.openFind(A)
    store.setQuery(A, 'stack trace')

    store.closeFind(A)

    expect(useFindStore.getState().open[A]).toBe(false)
    expect(useFindStore.getState().query[A]).toBe('stack trace')
  })

  test('every open request bumps the focus token, including one for an already open bar', () => {
    const store = useFindStore.getState()

    store.openFind(A)
    const first = useFindStore.getState().focusToken[A]
    store.openFind(A)

    expect(first).toBe(1)
    expect(useFindStore.getState().focusToken[A]).toBe(2)
  })

  test('forgetting a session leaves nothing of its bar behind', () => {
    const store = useFindStore.getState()
    store.openFind(A)
    store.setQuery(A, 'error')
    store.openFind(B)

    store.forgetSession(A)

    const state = useFindStore.getState()
    expect(state.open[A]).toBeUndefined()
    expect(state.query[A]).toBeUndefined()
    expect(state.focusToken[A]).toBeUndefined()
    expect(state.open[B]).toBe(true)
  })
})
