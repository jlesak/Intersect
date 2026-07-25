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
