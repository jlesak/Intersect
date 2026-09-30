---
paths:
  - "src/renderer/**"
  - "vitest.setup.dom.ts"
---

# Renderer

Rules for the React renderer in `src/renderer/src`. Each one is here because breaking it failed
silently: no error, no failing test, just a UI that stopped working.

## Stores

Build every renderer store with `createStore` from `@renderer/shared/store/createStore`, never
with zustand's `create` (ESLint enforces this). While developing and under test the factory runs
each selector twice against one state and fails the render if the two results differ, naming the
store, the call site and the fix.

A selector that returns a freshly built array or object on every call makes the store snapshot
unstable, and React answers that by re-rendering forever. There are exactly two sanctioned ways to
derive:

- **Flat shape-shaping** - the result is a new array or object whose entries are themselves stable
  values from the state. Wrap the selector at the call site in `useShallow` from
  `zustand/react/shallow`.
- **Nested or expensive derivations** - the result contains freshly built arrays or objects.
  `useShallow` compares one level deep and cannot stabilise these. Either keep the derived value in
  the store, or select a stable slice and derive from it with `useMemo` in the component. The PR
  table does the latter: `useShallow(selectPrList)` feeding `useMemo` for each tab and filter view.

A selector that allocates internally but answers with a primitive (a count, a flag, a found id) is
stable and needs neither.

Do not replace the guard with memoized selectors or an ESLint rule. Selectors such as
`workspacesForProject(state, projectId)` run with several live arguments at once, so a single-slot
memo thrashes and hands out a fresh array on alternating calls. A lint rule cannot see a nested
derivation that `useShallow` fails to stabilise, which is the case that crashes.

## Drags

`element.setPointerCapture()` does nothing in the running app. The call throws no error, but the
capture never takes hold, so once the pointer leaves the element no `pointermove` reaches it. A
resize handle is a few pixels wide, so the pointer leaves it on the first real move and the drag
looks dead.

Track a drag with `pointermove`, `pointerup` and `pointercancel` listeners on `window`, added on
pointerdown and removed by one closure kept in a ref. Call that closure from the unmount cleanup
too, or an interrupted drag leaves its listeners and the resize cursor behind.
`src/renderer/src/shared/ui/PanelResizer.tsx` is the reference implementation.

jsdom has no `PointerEvent`; `vitest.setup.dom.ts` polyfills it from `MouseEvent`. In tests, fire
drag moves at `window`, not at the element.

## Sidebar layout floor

Anything that makes a pinned sidebar panel taller can squeeze the middle slot below its own
content. Its footer then paints outside its box, the panel below wins the hit test, and a button
that looks normal ignores every click. Playwright reports it far from the cause, for example as
`<div class="ix-usage"> intercepts pointer events` in unrelated specs.

- `.ix-sidebar__body` and `.ix-sidebar__slot` need `min-height: min-content` spelled out.
  `overflow: hidden` sets the flex item's content-based minimum to zero, so dropping the floor
  brings the squeeze back.
- `.ix-sidebar__slot` is always rendered, even when the active context puts nothing in it.
  Without it the two stacked resize dividers land on the same pixel and only the lower one can be
  pressed.
- Whenever two stacked controls can meet, check what happens when the thing between them is
  empty.

The trap is height-dependent and hides on a tall screen: reproduce it with a 1280x700 window.
`src/renderer/src/shared/ui/appCss.test.ts`, `e2e/usage.spec.ts` and `e2e/sidebar-resize.spec.ts`
guard it.

## Escape inside the PR detail view

`PrDetail` handles Escape at window level and goes back to the table. An editor inside it that
handles Escape itself must call `e.stopPropagation()`. By the time the window handler runs, the
editor has already unmounted its textarea, so `escapeShouldGoBack` sees a detached target and
navigates away. `DraftCard`, `ThreadCard` and `CommentComposer` do this; any new editor in that
view must too.
