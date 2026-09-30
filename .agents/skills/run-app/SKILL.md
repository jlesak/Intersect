---
name: run-app
description: Launch the Intersect Electron app and drive it to see a change working - acceptance checks, screenshots, reproducing a UI bug - outside the committed e2e suite. Use when you need to see or show the running app rather than only run tests.
---

# Run and drive the app

The result is evidence about the running app: for each thing you set out to check, what you did,
what the app showed, and a screenshot you have looked at yourself. Afterwards nothing you started
is still running, and the working tree is as you found it.

The app always runs against a throwaway profile. The dev build names itself `Intersect`, so its
default profile directory is the one the owner's installed app uses, and an unisolated run reads
and writes the owner's real database.

## Scripted drive (the default)

Write a one-off spec at `e2e/diag.spec.ts`. The name is gitignored and lint-ignored, and
`reference.md` next to this file has a starting point. Launching through `launch()` from
`e2e/harness.ts` gives you a fresh temporary profile, an off-screen window, the canned Azure
DevOps, Jira and 1:1 backends, and cleanup of the app and its temp directories when the test
ends. Drive the flow the way a user would, assert what you can, and save screenshots with
`win.screenshot({ path })` under the OS temp directory.

Run it with `npm run e2e -- e2e/diag.spec.ts`, which builds first so the freshness guard passes.
Open every screenshot and judge it. A screenshot you have not looked at is not evidence.

- For anything that depends on the window size, pin it after launch, as `docs/agents/e2e.md`
  describes. Check narrow and short windows too when the change touches layout.
- Seed state through the UI or the harness helpers (`addWorkspace`, `stubFolderPick`,
  `connectedAdo`, `unconfiguredAdo`), never through the owner's data.
- `errors`, returned by `launch()`, collects renderer console errors; a clean check expects it to
  be empty.
- Delete `e2e/diag.spec.ts` when you are done. It is type-checked while it exists.

## Interactive drive

When you need to explore rather than follow a script, start the dev app with the renderer on the
Chrome DevTools port and a throwaway profile:
`npm run dev:debug -- --user-data-dir=<new temp dir>`. Drive it with `chrome-devtools-axi`
attached to that port (`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222`): `snapshot`,
`click`, `fill`, `screenshot`. This build talks to the real Azure DevOps and Jira with the owner's
credentials, so take no action there that others can see: no comments, votes, completed pull
requests or sent messages. Use the scripted drive for those flows.

Stop what you started when you are done: `chrome-devtools-axi stop`, then the dev process. It
binds local ports, so a leftover one breaks the next run.

## Claude Code

- `npm run e2e*` is excluded from the Bash sandbox, so the scripted drive runs as a plain
  command. Keep it plain: no `cd`, no `&&` chain, no redirection, no leading variable assignment.
- The interactive drive is not excluded. The dev server and the DevTools bridge bind local ports,
  which the sandbox refuses, so it needs a run outside the sandbox, and each one goes through the
  owner's approval. Prefer the scripted drive.
- Run `npm run dev:debug` with `run_in_background: true` and stop it with `TaskStop`. The owner's
  settings deny `kill` and `pkill`.

## Codex

Start Codex here with `codex -p intersect` and run from the issue worktree. Check that
`~/.codex/intersect.config.toml` exists first: CLI 0.156.1 silently accepts a missing profile
and otherwise leaves global skills visible. If it is absent, stop and ask the owner to install
it. Prefer the scripted
`e2e/diag.spec.ts` drive. The project rule lets plain `npm run e2e` launch Electron outside the
sandbox; a sandbox probe failed at Electron launch. Run it in a tracked session and wait for its
result. Inspect each screenshot before reporting UAT. Remove the scratch spec and stop any
processes you started, leaving the tree as found. Interactive `dev:debug` and
`chrome-devtools-axi` may need separate permission for local ports; request a narrow interactive
approval when needed, and report the blocked command if approval cannot be surfaced.
