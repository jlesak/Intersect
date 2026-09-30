---
paths:
  - "e2e/**"
  - "tooling/**"
  - "playwright.config.ts"
---

# End-to-end tests

Playwright drives the built Electron app. `npm run e2e` builds first and then runs the whole
suite; `npm run e2e -- e2e/<name>.spec.ts` builds and runs one spec. The suite is a merge gate and
has no retries on purpose.

## Launching

Launch the app only through `launch()` in `e2e/harness.ts` (ESLint bans `_electron` elsewhere).
Every launch gets a temporary profile and an empty Claude projects directory, and the harness
closes the app after the test whatever its outcome. `unconfiguredAdo()` and `connectedAdo()` pin
whether the machine counts as connected to Azure DevOps; without one, a spec that counts syncs
passes or fails depending on whose laptop runs it. With `INTERSECT_E2E=1` the core answers Azure
DevOps, Jira and 1:1 calls from the canned stubs in `src/core/*/*E2eStub.ts`.

The app runs off screen: the harness sets `INTERSECT_HIDDEN_WINDOW=1`, so a suite run never takes
the keyboard or the foreground. `E2E_HEADED=1`, that exact value, shows the window for watching a
spec.

`tooling/e2eLaunchEnv.ts` strips `ELECTRON_RUN_AS_NODE` from the launch environment. VSCode
terminals export it, and with it Electron starts as plain Node, rejects Playwright's
`--remote-debugging-port=0`, and every spec fails at launch as if the build were broken. If that
failure comes back, check that `launchEnv` still wraps the environment at the `electron.launch()`
call, and add any new offender to `STRIPPED_LAUNCH_VARS` instead of working around it with
`env -u`.

## The build freshness guard

`tooling/e2eGlobalSetup.ts` refuses to start a run whose build no longer describes the working
tree: every file in `out/main`, `out/preload` and `out/renderer` must be newer than every watched
input. Watched inputs are `src/**` except `*.test.*`, `*.spec.*` and `__tests__/`, plus
`electron.vite.config.*`, `package.json`, `package-lock.json`, the root `tsconfig*.json` and the
root `.env*` files. A tie counts as stale.

The fix for a refusal is always `npm run build`. These refusals are correct even though they look
arbitrary:

- after `git checkout`, `git stash pop` or `git pull`, which rewrite source mtimes;
- after adding, deleting or renaming any file under `src/`, including a test file or a stray
  `.DS_Store`, because only the parent directory's mtime records it;
- after editing only `src/main/**` and running `npm run dev`, which leaves `out/renderer` older;
- after editing a source file during a build's write window.

`E2E_ALLOW_STALE=1`, that exact value, runs against a stale build on purpose and logs how stale.
It does not cover a missing build. Do not relax the guard: two weaker comparisons shipped first
and both reported stale builds as fresh. Known gap: renaming or deleting a watched root file reads
as fresh.

Each worktree has its own `out/`, so runs in different worktrees do not collide. Two builds in one
checkout corrupt each other's output.

## Window size

The CI runner's default window is much smaller than a developer's: on macos-15 the PR detail pane
was about 780px wide. An assertion that depends on layout width or height (drag ceilings, clamps,
wrapping, stacked panels) must pin the window after every launch, relaunches included, with
`app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(W, H))`, and then
assert that the pane really got that size so a clamping screen fails loudly. `e2e/usage.spec.ts`
and `e2e/prInbox.spec.ts` use this pattern.

## Failures

The suite has a known flake. Re-run a failed run once; a second failure is real and needs
investigating, never a third run. A failure keeps its trace in `test-results/`
(`npx playwright show-trace <trace.zip>`), and CI uploads the same traces as the
`playwright-traces` artifact. Without the trace, most failures read as a bare timeout.

## Scratch specs

`e2e/diag.spec.ts` and `e2e/screenshot.spec.ts` are gitignored and lint-ignored, for one-off drives
of the app outside the suite (see the `run-app` skill). They are still type-checked while they
exist, because `tsconfig.node.json` includes `e2e/**`. Delete them when done.
