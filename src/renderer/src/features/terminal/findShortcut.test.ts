import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useFindStore } from './findStore'
import { installTerminalFindShortcut, isTerminalFindTarget, resolveFindSession } from './findShortcut'

let uninstall: (() => void) | null = null

/**
 * A stage with one terminal pane per session id, in the order given. Every pane carries its own
 * tab strip above the terminal, the way the split stage draws it: the strip lives inside the
 * stage and holds focusable elements, so it raises keystrokes just as the terminal does.
 */
function stage(...sessionIds: string[]): HTMLElement {
  const stage = document.createElement('div')
  stage.className = 'ix-stage'
  for (const sessionId of sessionIds) {
    const pane = document.createElement('div')
    pane.className = 'ix-pane'
    const bar = document.createElement('div')
    bar.className = 'ix-tabbar'
    const tab = document.createElement('div')
    tab.className = 'ix-tab'
    tab.tabIndex = 0
    const rename = document.createElement('input')
    rename.className = 'ix-tab__rename'
    tab.appendChild(rename)
    bar.appendChild(tab)
    const body = document.createElement('div')
    body.className = 'ix-pane__body'
    const host = document.createElement('div')
    host.className = 'ix-pane__host'
    host.dataset.sessionId = sessionId
    // xterm takes the keystroke on a helper textarea deep inside the host.
    host.appendChild(document.createElement('textarea'))
    body.appendChild(host)
    pane.appendChild(bar)
    pane.appendChild(body)
    stage.appendChild(pane)
  }
  document.body.appendChild(stage)
  return stage
}

/** One pane's tab, counted in the order the stage lays its panes out. */
const tabIn = (panes: HTMLElement, index: number): HTMLElement =>
  panes.querySelectorAll<HTMLElement>('.ix-tab')[index]

/** One pane's rename field, counted the same way. */
const renameIn = (panes: HTMLElement, index: number): HTMLElement =>
  panes.querySelectorAll<HTMLElement>('.ix-tab__rename')[index]

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

  // The strip sits inside the stage, so a rename field is now an ordinary text field standing in
  // the terminal area, and Cmd+F belongs to the field for as long as it is up.
  test('rejects the rename field of a tab, which stands inside the terminal area', () => {
    const panes = stage('ws1:a')

    expect(isTerminalFindTarget(renameIn(panes, 0))).toBe(false)
  })
})

describe('resolveFindSession', () => {
  test('prefers the pane the keystroke came from', () => {
    const panes = stage('ws1:a', 'ws1:b')
    const second = panes.querySelectorAll('textarea')[1]

    expect(resolveFindSession(second)).toBe('ws1:b')
  })

  // A tab strip carries no session id of its own, so the pane around it is what says which
  // terminal the user was looking at.
  test('answers with the pane whose tab strip raised the keystroke', () => {
    const panes = stage('ws1:a', 'ws1:b')

    expect(resolveFindSession(tabIn(panes, 1))).toBe('ws1:b')
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

  test('Cmd+F from a pane tab strip opens the bar of that same pane', () => {
    const panes = stage('ws1:a', 'ws1:b')
    uninstall = installTerminalFindShortcut()

    const prevented = pressFind(tabIn(panes, 1))

    expect(prevented).toBe(true)
    expect(useFindStore.getState().open).toEqual({ 'ws1:b': true })
  })

  // Taking the key here would blur the field, and blurring commits the rename.
  test('Cmd+F while a tab is being renamed belongs to the rename field', () => {
    const panes = stage('ws1:a')
    uninstall = installTerminalFindShortcut()

    const prevented = pressFind(renameIn(panes, 0))

    expect(prevented).toBe(false)
    expect(useFindStore.getState().open).toEqual({})
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
