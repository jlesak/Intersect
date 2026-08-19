/// <reference types="vite/client" />
import { create } from 'zustand'
import type { StateCreator, StoreApi, UseBoundStore } from 'zustand'
import { rendererLogger } from '../logging/logger'

/**
 * Creates a store whose selectors are checked for reference stability while developing and under
 * test.
 *
 * A selector that builds a fresh array or object every time it runs makes the store snapshot
 * unstable, and React answers an unstable snapshot by re-rendering the component forever. The
 * failure surfaces far from its cause - a frozen window and a minified React error - so this
 * factory turns it into a named, actionable error at the offending call site instead.
 *
 * Middleware is deliberately not supported: no store in this app uses any, and the stability
 * check assumes the plain store contract.
 */
export const createStore =
  <T>() =>
  (initializer: StateCreator<T, [], []>): UseBoundStore<StoreApi<T>> => {
    const useBoundStore = create<T>()(initializer)
    if (!import.meta.env.DEV) return useBoundStore
    // The declaring module is the store's name; the line it sits on adds nothing to it.
    return guardSelectors(useBoundStore, callSite(new Error().stack).replace(/:\d+:\d+$/, ''))
  }

/**
 * Wraps the hook so that every selector is proven stable before its result is handed to React.
 * The store API is copied across unchanged, so the guarded hook stays interchangeable with the
 * one zustand produced.
 */
function guardSelectors<T>(
  useBoundStore: UseBoundStore<StoreApi<T>>,
  storeName: string
): UseBoundStore<StoreApi<T>> {
  function useGuardedStore<U>(selector?: (state: T) => U): T | U {
    if (!selector) return useBoundStore()
    assertStable(selector, useBoundStore.getState(), storeName)
    return useBoundStore(selector)
  }
  return Object.assign(useGuardedStore as UseBoundStore<StoreApi<T>>, useBoundStore)
}

/** Selectors already diagnosed, so a retrying error boundary cannot flood the console. */
const reported = new Set<string>()

/**
 * Fails when a selector answers the same state with two different references. A stable selector
 * cannot do that, so there is nothing here to tune and no false positive to suppress.
 */
function assertStable<T, U>(selector: (state: T) => U, state: T, storeName: string): void {
  if (Object.is(selector(state), selector(state))) return

  const message = unstableSelectorMessage(selector, storeName, callSite(new Error().stack))
  // The throw already stops this render, but an error boundary can swallow it and retry the same
  // tree indefinitely. One logged copy per selector keeps the diagnosis visible without flooding.
  if (!reported.has(message)) {
    reported.add(message)
    rendererLogger().child('renderer').error(message)
  }
  throw new Error(message)
}

function unstableSelectorMessage(
  selector: (...args: never[]) => unknown,
  storeName: string,
  usedAt: string
): string {
  return [
    `Unstable selector on the ${storeName} store, used at ${usedAt}.`,
    '',
    'It returned a different reference for one and the same state. React treats that as a',
    'changed snapshot and re-renders the component forever (React error #185).',
    '',
    // A useShallow-wrapped selector reports the wrapper's body rather than its own, which is why
    // the call site above carries the real identification.
    `  selector: ${String(selector).replace(/\s+/g, ' ')}`,
    '',
    'Pick the fix that matches what the selector derives:',
    '  - A flat array or object whose entries are already stable: wrap the call site in',
    "    useShallow from 'zustand/react/shallow'.",
    '  - Anything with fresh arrays or objects nested inside the result: useShallow compares one',
    '    level deep and cannot stabilise it. Select a stable slice and derive from it with',
    '    useMemo in the component, or keep the derived value in the store.'
  ].join('\n')
}

/**
 * The first frame outside this factory, as `features/prInbox/components/PrBoard.tsx:15:22`.
 * Paths arrive as absolute files under test and as dev-server URLs while running the app, so both
 * the origin and any cache-busting query are trimmed away.
 */
function callSite(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (line.includes('shared/store/createStore.ts')) continue
    const match = /([^\s()?]+\.tsx?)(?:\?[^\s():]*)?(:\d+:\d+)/.exec(line)
    if (!match) continue
    const src = match[1].lastIndexOf('/src/')
    return (src === -1 ? match[1] : match[1].slice(src + '/src/'.length)) + match[2]
  }
  return 'an unknown module'
}
