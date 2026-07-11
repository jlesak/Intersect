import { afterEach, describe, expect, test } from 'vitest'
import { escapeShouldGoBack } from './escapeNav'

const el = (className: string, parent?: HTMLElement): HTMLElement => {
  const node = document.createElement('div')
  node.className = className
  ;(parent ?? document.body).appendChild(node)
  return node
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('escapeShouldGoBack', () => {
  test('navigates back on a plain Escape in the detail chrome', () => {
    expect(escapeShouldGoBack(false, el('ix-pr-header'))).toBe(true)
  })

  test('never navigates back while a review is running', () => {
    expect(escapeShouldGoBack(true, el('ix-pr-header'))).toBe(false)
  })

  test('does not navigate back when Escape lands inside the review terminal', () => {
    const host = el('ix-pr-review__term')
    const inner = el('xterm-screen', host)
    expect(escapeShouldGoBack(false, inner)).toBe(false)
  })

  test('does not navigate back when Escape lands inside the Monaco diff editor', () => {
    const host = el('ix-pr-diff__host')
    const inner = el('monaco-editor', host)
    expect(escapeShouldGoBack(false, inner)).toBe(false)
  })

  test('navigates back when the target is not an element', () => {
    expect(escapeShouldGoBack(false, null)).toBe(true)
  })
})
