## Running and building

Electron app (electron-vite), so there is no browser dev server to visit.

- `npm run dev` - run the app in development.
- `npm run typecheck` - both tsconfigs; run before tests, it catches most breakage first.
- `npm test` - unit tests (vitest). `npm run e2e` builds and runs Playwright.
- `npm run lint` - eslint.
- `npm run pack:mac` - packaged build; copy the result from `dist/mac*/` to `/Applications` to
  try it as the installed app.

The gate before any PR is: typecheck, lint, test, e2e.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub repository `jlesak/Intersect`. See
`docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Intersect is a single-context repository. See `docs/agents/domain.md`.
