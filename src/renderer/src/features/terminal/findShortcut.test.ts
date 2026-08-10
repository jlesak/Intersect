import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useFindStore } from './findStore'
import { installTerminalFindShortcut, isTerminalFindTarget, resolveFindSession } from './findShortcut'

let uninstall: (() => void) | null = null

/** A stage with one terminal pane per session id, in the order given. */
function stage(...sessionIds: string[]): HTMLElement {
  const stage = document.createElement('div')
  stage.className = 'ix-stage'
  for (const sessionId of sessionIds) {
    const pane = document.createElement('div')
    pane.className = 'ix-pane'
    const host = document.createElement('div')
    host.className = 'ix-pane__host'
    host.dataset.sessionId = sessionId
    // xterm takes the keystroke on a helper textarea deep inside the host.
    host.appendChild(document.createElement('textarea'))
    pane.appendChild(host)
    stage.appendChild(pane)
  }
  document.body.appendChild(stage)
  return stage
}

/** Cmd+F as the browser delivers it, from whatever currently holds focus. */
function pressFind(target: EventTarget): boolean {
  const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  useFindStore.setState({ open: {}, query: {}, focusToken: {} })
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  document.body.replaceChildren()
})

describe('isTerminalFindTarget', () => {
  test('accepts the terminal itself', () => {
    const host = stage('ws1:a').querySelector('textarea')

    expect(isTerminalFindTarget(host)).toBe(true)
  })

  test('accepts nothing being focused at all', () => {
    stage('ws1:a')

    expect(isTerminalFindTarget(document.body)).toBe(true)
  })

  test('rejects an input outside the terminal area, which has its own find', () => {
    stage('ws1:a')
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)

    expect(isTerminalFindTarget(elsewhere)).toBe(false)
  })
})

describe('resolveFindSession', () => {
  test('prefers the pane the keystroke came from', () => {
    const panes = stage('ws1:a', 'ws1:b')
    const second = panes.querySelectorAll('textarea')[1]

    expect(resolveFindSession(second)).toBe('ws1:b')
  })

  test('falls back to the first pane on screen when nothing is focused', () => {
    stage('ws1:a', 'ws1:b')

    expect(resolveFindSession(document.body)).toBe('ws1:a')
  })

  test('answers with nothing when no terminal is on screen', () => {
    expect(resolveFindSession(document.body)).toBeNull()
  })
})

describe('the terminal find key', () => {
  test('Cmd+F opens the bar of the pane it was pressed in, and never reaches the shell', () => {
    const panes = stage('ws1:a', 'ws1:b')
    uninstall = installTerminalFindShortcut()

    const prevented = pressFind(panes.querySelectorAll('textarea')[1])

    expect(prevented).toBe(true)
    expect(useFindStore.getState().open).toEqual({ 'ws1:b': true })
  })

  test('Cmd+F inside an editor outside the terminal area opens nothing', () => {
    stage('ws1:a')
    const editor = document.createElement('textarea')
    document.body.appendChild(editor)
    uninstall = installTerminalFindShortcut()

    const prevented = pressFind(editor)

    expect(prevented).toBe(false)
    expect(useFindStore.getState().open).toEqual({})
  })

  test('Ctrl+F stays the shell readline binding it has always been', () => {
    const panes = stage('ws1:a')
    uninstall = installTerminalFindShortcut()
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    panes.querySelector('textarea')?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(useFindStore.getState().open).toEqual({})
  })

  test('Caps Lock does not decide whether the key works', () => {
    const panes = stage('ws1:a')
    uninstall = installTerminalFindShortcut()
    // Caps Lock reports the letter uppercase and leaves shiftKey false, so a case-sensitive guard
    // would silently drop the key.
    const event = new KeyboardEvent('keydown', {
      key: 'F',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })

    panes.querySelector('textarea')?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(useFindStore.getState().open).toEqual({ 'ws1:a': true })
  })

  test('Shift+Cmd+F is a different shortcut and is left alone', () => {
    const panes = stage('ws1:a')
    uninstall = installTerminalFindShortcut()
    const event = new KeyboardEvent('keydown', {
      key: 'F',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })

    panes.querySelector('textarea')?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(useFindStore.getState().open).toEqual({})
  })

  test('leaving the terminal area takes the key with it', () => {
    const panes = stage('ws1:a')
    installTerminalFindShortcut()()

    const prevented = pressFind(panes.querySelector('textarea') as EventTarget)

    expect(prevented).toBe(false)
    expect(useFindStore.getState().open).toEqual({})
  })
})
