# Intersect

A personal, single-user macOS desktop app (Electron, TypeScript, React) that gathers its owner's
daily developer and team-lead tools into one workspace: terminals and Claude Code sessions, an
Azure DevOps PR inbox, My Work, time tracking, 1:1s and TODOs. macOS only. The repository is
public, so nothing about the owner's employer, colleagues or private data goes into it.

## Commands

The app is an Electron app built with electron-vite; there is no browser dev server to visit.

- `npm run dev` - run the app in development. It uses the installed app's profile and database,
  so a run can migrate or overwrite the owner's real data. Agents run the app only through the
  e2e suite or the `run-app` skill, which give it a throwaway profile.
- `npm run typecheck` - both tsconfigs. The cheapest way to find breakage; run it first.
- `npm test` - Vitest unit and integration tests; `npx vitest run <path>` for one file.
- `npm run lint` - ESLint, which is also the only formatter.
- `npm run e2e` - builds, then runs Playwright against the built app, off screen.
  `npm run e2e -- e2e/<name>.spec.ts` builds and runs one spec.
- `npm run pack:mac` - packaged build in `dist/mac*/`. Only the owner installs a build into
  `/Applications`.

The gate before any PR is typecheck, lint, test and e2e, all green. CI (GitHub Actions on
macos-15) runs the same checks in two jobs. Branch protection on `main` requires both to pass
before a PR merges, and it applies to admins too. The e2e suite has a known flake: re-run a
failure once; a second failure is real.

## Architecture

- `src/main` - Electron main: window, menu, native dialogs, lifecycle. A thin bridge that answers
  the Electron-only channels listed in `src/common/coreBridge.ts` and forwards the rest to the
  core.
- `src/core` - the headless core, an Electron utilityProcess (plain Node, no `electron` imports).
  It owns the SQLite database (`node:sqlite`), the PTYs (`node-pty`, imported only by
  `src/core/pty/nodePtySpawn.ts`) and every service.
- `src/preload` - the typed contextBridge, `window.intersect`.
- `src/renderer/src` - the React UI: `app/` is the shell, `shared/` holds primitives, the store
  factory and the UI kit, and `features/<slice>/` are vertical slices. A slice imports another
  only through its `index.ts` barrel.
- `src/common` - cross-process contracts: domain types, IPC channels, pure shared logic.
- `e2e` - Playwright specs, which launch the app only through `e2e/harness.ts`.
- `tooling` - repository tooling outside the app: the e2e build-freshness guard, the launch
  environment and the app register.
- `docs/DESIGN*.md`, `docs/2026-07-07-intersect-final-form-design.md` and `docs/specs/` -
  design history and feature specs. They record intent at the time; the code and the issue are
  the current truth.

## Conventions

- ESLint is the only formatting authority. There is no Prettier, and running it rewrites whole
  files into the wrong style. House style: no semicolons, single quotes, 2-space indent, about 100
  columns. Match the surrounding file.
- The ESLint config encodes the architecture: slice barrels, `node-pty` confinement, no
  `electron` in the core, the core's ownership of the database, `createStore` for renderer
  stores, no `console`, and app launches only through the e2e harness. Fix the code, not the rule.
- Test logic with Vitest (the database against in-memory `node:sqlite`); test whole-app flows,
  layout and terminals with e2e. A bug fix starts with a failing test that reproduces the bug,
  at integration level when the bug spans units. Never weaken or skip a test to get green.

## Git and worktrees

- Several agent sessions share the main checkout, and a branch switch there takes other
  sessions' edits with it. Work that edits, builds or runs e2e belongs in a git worktree under
  `.claude/worktrees/<slug>` on its own branch. Never switch branches or pull in the shared
  checkout. The owner fast-forwards it after merges, from their own terminal. Until then, a
  session started there loads the skills, agents, settings and instructions as they were before
  the merge, and `implement-issue` stops at its first stage.
- Branch names: `feature/gh<N>-<slug>` or `fix/gh<N>-<slug>` from `origin/main`, and
  `chore/<slug>` for tooling and docs.
- A new worktree has no `node_modules`. Symlink the main checkout's; run `npm ci` in the worktree
  instead only when its `package-lock.json` differs from the main checkout's. Each worktree has
  its own `out/`, so builds in different worktrees never collide.
- Stage explicit paths. Never `git add -A`, `git add --all` or `git add .`: that once committed
  the `node_modules` symlink, and merging the commit replaced another worktree's real
  `node_modules` with the link.
- Never commit or push on `main`, and never force-push. `main` changes only through merged PRs.
- Commit messages: `type(scope): subject`, with `feat`, `fix`, `test`, `refactor` or `chore`, and
  a subject that says what changed for the user.
- After a failed or interrupted agent run, read `git log` before redoing anything: a run reported
  as failed may already have committed.

## Who decides what

The owner is the product owner. They decide functionality, meaning what users see and can do,
and major technical direction: new dependencies, the data model, IPC contracts, architecture.
Agents decide implementation detail and list the decisions they made in the PR description.
When a change would alter user-visible behavior beyond what the issue or an approved plan says,
stop and ask instead of choosing. Decisions the owner has already made, including declined
proposals, are in `docs/agents/product.md`; do not propose a declined item again.

## Topic docs

Read the topic doc before working in its area:

- `docs/agents/renderer.md` - before changing `src/renderer`: store rules, drags, sidebar
  layout, Escape handling.
- `docs/agents/e2e.md` - before changing `e2e/`, `tooling/` or `playwright.config.ts`, and when
  e2e fails.
- `docs/agents/product.md` - before planning, reviewing or writing an issue for any user-visible
  change.
- `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md` - before reading, writing or
  labelling issues.
- `docs/agents/domain.md` - vocabulary and decision records.

`renderer.md` and `e2e.md` carry `paths:` frontmatter, and Claude Code loads them automatically
through `.claude/rules/` when it reads a matching file. Keep the frontmatter in step with the
areas a doc covers. A new topic doc needs an entry in the list above, and one with `paths:` also
needs a relative symlink `.claude/rules/<topic>.md` pointing at it.

## Skills

The project skills live in `.agents/skills/`; Claude Code reaches them through symlinks in
`.claude/skills/`.

- `implement-issue` - takes one GitHub issue through plan, owner approval, implementation,
  review, verification, PR and merge. Started by the owner.
- `write-issue` - turns an idea or a bug report into an issue an agent can implement, or triages
  an existing issue into that shape. Started by the owner.
- `run-app` - launches the app and drives it to see a change working.
- `retro` - folds a lesson from a run back into this setup as a PR the owner merges.

Each tool's own files are written and reviewed by that tool: Claude Code owns `.claude/`, Codex
owns `.codex/`, each skill's `agents/openai.yaml` and the Codex sections of the skills. Neither
edits the other's.

## Precedence over the global setup

In this repository:

- The project skills replace the superpowers plugin's planning and execution workflow. Issue work
  goes through `implement-issue`. Claude Code: the project settings turn the plugin off here.
  Codex: the owner starts Codex here with `codex -p intersect`, a user-level profile that switches
  off the conflicting skills. If a superpowers skill is still offered, do not use brainstorming,
  writing-plans, executing-plans, subagent-driven-development, using-git-worktrees,
  finishing-a-development-branch or requesting-code-review here.
- Ignore the global session-start prompt about Jira issues and Toggl time tracking. Work here is
  tracked in this repository's GitHub issues.
- Inside the `implement-issue` pipeline, the owner's review of the plan page replaces the global
  "invoke /grill-me when planning" rule, because pipeline agents cannot interview the owner.
  Outside the pipeline the global rule stands.
