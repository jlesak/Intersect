@AGENTS.md

## Claude Code

- The `implement-issue` pipeline may commit, push, open a PR and merge it on the feature branch of
  the issue it runs, once the owner has approved the plan. That overrides the global "never
  commit unless the user tells you" rule for the pipeline only; everywhere else the global rule
  stands. The `retro` skill may commit and open its PR, but never merges it.
- `implement-issue` and `retro` work in git worktrees under `.claude/worktrees/` and move the
  session in with `EnterWorktree`. The mechanics are in the skills.
- `gh`, `npx -y lavish-axi`, `npm run e2e`, `npm test`, `npx vitest run`, `npm ci`,
  `git worktree add`, `git worktree remove` and `git push` are excluded from the Bash sandbox.
  They need the network, the npm cache, the keychain or local ports, or they write the protected
  `.claude/` files of a worktree. The exclusion applies only to a plain command: no `cd`, `&&`
  chain, pipe, redirection or subshell. Otherwise the command stays sandboxed and fails:
  `npm test` in about 50 tests that bind a local port, `git push` with "could not read
  Username", and `git worktree remove` halfway, leaving a damaged worktree.
- The pipeline agents are in `.claude/agents/` and pin `claude-opus-5-5` at `high` effort.
- Skills are symlinks from `.claude/skills/` to `.agents/skills/`, and the path-scoped rules in
  `.claude/rules/` are symlinks to `docs/agents/`. Edit the targets, not the links.
- Auto-memory notes written before this setup can disagree with it, for example about whether
  delegation is optional or whether subagents run e2e. In this repository, these files, the
  skills and the agent definitions win.
