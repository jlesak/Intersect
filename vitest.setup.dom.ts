import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest globals are off, so Testing Library cannot register its own auto-cleanup. Unmount every
// client-rendered tree between tests, otherwise a leaked root keeps re-rendering into the next one.
afterEach(() => {
  cleanup()
})

// xterm probes a 2d canvas context the moment it is imported, and jsdom answers every call with a
// multi-line "not implemented" dump on stderr. That noise buries the actual test output, and no
// renderer test asserts on anything drawn, so an inert context is enough.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext

// Node 25 defines a `localStorage` global of its own, and it wins over the one jsdom would have
// installed. Without a storage file behind it that global is an inert object carrying none of the
// Storage methods, so any read throws a TypeError instead of returning a value. The renderer keeps
// its crash-recovery markers there, so tests need a store that behaves like the browser's: a real
// in-memory Storage, replacing the global outright.
const webStorage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string): string | null => webStorage.get(key) ?? null,
    setItem: (key: string, value: string): void => void webStorage.set(key, String(value)),
    removeItem: (key: string): void => void webStorage.delete(key),
    clear: (): void => webStorage.clear(),
    key: (index: number): string | null => [...webStorage.keys()][index] ?? null,
    get length(): number {
      return webStorage.size
    }
  }
})

// jsdom implements no layout, so it ships no scrollIntoView at all. Any component that keeps a
// selected row in view calls it from an effect, where the resulting TypeError fails the test for a
// reason that has nothing to do with the behaviour under test. Scrolling is not observable here.
Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView

// jsdom ships no PointerEvent, so Testing Library falls back to a plain Event for every pointer
// gesture: the button and the coordinates never reach the handler, and a test can only ever assert
// that nothing happened. Pointer input is how the app's draggable dividers work, so the tests need
// the real shape - and MouseEvent already carries all the geometry one needs.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill
  })
}
