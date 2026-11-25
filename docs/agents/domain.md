# Domain docs

Intersect is a single-context repository.

## Before exploring

- Read `CONTEXT.md` at the repository root if it exists.
- Read the append-only decision log in [`docs/DECISIONS.md`](../DECISIONS.md), and any relevant
  feature spec in `docs/specs/`. If `CONTEXT.md` does not exist, proceed silently.

## Vocabulary

If `CONTEXT.md` exists, use its canonical terminology in issue titles, implementation plans,
tests, and code. If a required concept is missing, reconsider whether new terminology is necessary
or flag the gap for a documentation decision.

## Architectural decisions

Surface conflicts with the latest applicable row in [`docs/DECISIONS.md`](../DECISIONS.md)
explicitly. A reversal appends a row that names the superseded decision; do not rewrite history.

Product decisions the owner has already made, including declined proposals, are in
`docs/agents/product.md`.
