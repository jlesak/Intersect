import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ISearchResultChangeEvent } from '@xterm/addon-search'

// The controller owns the live xterm and its search addon; here it is a recorder, so the bar's
// own contract - which search it asks for, and when it stops asking - is what the test reads.
const controllerMock = vi.hoisted(() => {
  const listeners: Array<(event: ISearchResultChangeEvent) => void> = []
  return {
    listeners,
    findInSession: vi.fn(() => true),
    clearSessionSearch: vi.fn(),
    focusSession: vi.fn(),
    onSessionSearchResults: vi.fn(
      (_sessionId: string, listener: (event: ISearchResultChangeEvent) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      }
    )
  }
})
vi.mock('../terminalController', () => controllerMock)

import { useFindStore } from '../findStore'
import { FindBar, matchLabel } from './FindBar'

const SID = 'ws1:tab1'

const input = (): HTMLInputElement => screen.getByLabelText('Find in terminal') as HTMLInputElement
const count = (): string | null => document.querySelector('.ix-find__count')?.textContent ?? null

/** Report a tally the way the addon does once a search has run. */
function reportResults(resultIndex: number, resultCount: number): void {
  act(() => {
    for (const listener of controllerMock.listeners) listener({ resultIndex, resultCount })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  controllerMock.listeners.length = 0
  useFindStore.setState({ open: { [SID]: true }, query: {}, focusToken: { [SID]: 1 } })
})

describe('matchLabel', () => {
  test('a query with no hits reads as a zero count', () => {
    expect(matchLabel(-1, 0)).toBe('0/0')
  })

  test('a tracked position reads as one-based current over total', () => {
    expect(matchLabel(0, 12)).toBe('1/12')
    expect(matchLabel(11, 12)).toBe('12/12')
  })

  test('a total the addon can no longer place the caret in reads as the total alone', () => {
    expect(matchLabel(-1, 4000)).toBe('4000')
  })
})

describe('FindBar', () => {
  test('opening puts the caret in the input', () => {
    render(<FindBar sessionId={SID} />)

    expect(document.activeElement).toBe(input())
  })

  test('asking again selects the query that is already there, so typing replaces it', () => {
    useFindStore.setState({ query: { [SID]: 'error' } })
    render(<FindBar sessionId={SID} />)
    input().setSelectionRange(5, 5)

    act(() => useFindStore.getState().openFind(SID))

    expect(document.activeElement).toBe(input())
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 5])
  })

  test('typing searches forward from what is on screen, growing the match as it goes', () => {
    render(<FindBar sessionId={SID} />)

    fireEvent.change(input(), { target: { value: 'err' } })

    expect(controllerMock.findInSession).toHaveBeenCalledWith(SID, 'err', 'next', true)
    expect(useFindStore.getState().query[SID]).toBe('err')
  })

  test('Enter steps to the next match and Shift+Enter to the previous one', () => {
    useFindStore.setState({ query: { [SID]: 'err' } })
    render(<FindBar sessionId={SID} />)

    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })

    expect(controllerMock.findInSession).toHaveBeenNthCalledWith(1, SID, 'err', 'next')
    expect(controllerMock.findInSession).toHaveBeenNthCalledWith(2, SID, 'err', 'previous')
  })

  test('the bar shows how many matches the terminal found and where it stands', () => {
    render(<FindBar sessionId={SID} />)

    reportResults(2, 9)

    expect(count()).toBe('3/9')
  })

  test('emptying the query puts the count back to nothing without a search', () => {
    render(<FindBar sessionId={SID} />)
    fireEvent.change(input(), { target: { value: 'err' } })
    reportResults(0, 3)

    fireEvent.change(input(), { target: { value: '' } })

    expect(count()).toBe('0/0')
    expect(controllerMock.findInSession).toHaveBeenLastCalledWith(SID, '', 'next', true)
  })

  test('Escape drops the highlights, closes the bar and hands the keyboard back to the shell', () => {
    render(<FindBar sessionId={SID} />)

    fireEvent.keyDown(input(), { key: 'Escape' })

    expect(controllerMock.clearSessionSearch).toHaveBeenCalledWith(SID)
    expect(useFindStore.getState().open[SID]).toBe(false)
    expect(controllerMock.focusSession).toHaveBeenCalledWith(SID)
  })

  test('the close button does exactly what Escape does', () => {
    render(<FindBar sessionId={SID} />)

    fireEvent.click(screen.getByLabelText('Close find'))

    expect(controllerMock.clearSessionSearch).toHaveBeenCalledWith(SID)
    expect(useFindStore.getState().open[SID]).toBe(false)
    expect(controllerMock.focusSession).toHaveBeenCalledWith(SID)
  })

  test('a keystroke in the bar carries its own pane, not the first one on screen', () => {
    render(<FindBar sessionId={SID} />)

    expect(document.querySelector('.ix-find')?.getAttribute('data-session-id')).toBe(SID)
  })
})
