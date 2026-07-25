# Domain docs

Intersect is a single-context repository.

## Before exploring

- Read `CONTEXT.md` at the repository root if it exists.
- Read ADRs in `docs/adr/` that touch the area being changed.
- If these files do not exist, proceed silently. Producer workflows create them lazily when a
  glossary term or architectural decision needs to be recorded.

## Vocabulary

Use the canonical terminology defined in `CONTEXT.md` in issue titles, implementation plans,
tests, and code. If a required concept is missing, reconsider whether new terminology is necessary
or flag the gap for a documentation decision.

## Architectural decisions

Surface conflicts with an existing ADR explicitly. Do not silently override a documented
decision.

## Renderer stores

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
  board does the latter: `useShallow(selectPrList)` feeding `useMemo(() => groupBoardColumns(prs))`.

A selector that allocates internally but answers with a primitive (a count, a flag, a found id) is
stable and needs neither.
