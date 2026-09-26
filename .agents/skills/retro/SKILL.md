---
name: retro
description: Fold lessons from an agent run back into Intersect's agent setup - AGENTS.md, docs/agents, the skills and the agent definitions - as a pull request the owner reviews and merges. Use at the end of an implement-issue run that produced a lesson, or when the owner asks for a retro.
disable-model-invocation: true
---

# Retro

The result is the smallest edit to the setup that stops a future run from repeating a mistake,
committed to the rolling `chore/agents-retro` branch and in an open PR that the owner reviews.
Agents never merge that PR. If there is no real lesson, there is no retro.

## What counts as a lesson

A lesson cost this run something (a review round, a wrong turn, a stop for the owner, a
correction) and a future run would pay it again unless something is written down: a fact about
the codebase an agent lacked, an instruction that misled, a handoff between stages that lost
information, a tool mechanic that failed.

These are not lessons: a product bug (file an issue instead), something the setup already says
(then ask why it was missed, which may be the real lesson), a preference about style, and a
one-off accident.

## Where it goes

Put each rule where an agent will be reading when it needs it:

- `AGENTS.md` for rules about the whole repository;
- `docs/agents/<topic>.md` for knowledge about one area, keeping its `paths:` frontmatter in step.
  A new topic doc also needs an entry in the `AGENTS.md` topic index and, when it has `paths:`,
  a relative symlink `.claude/rules/<topic>.md` pointing at it, or Claude Code never loads it;
- a skill under `.agents/skills/` (edit the files there, not through the `.claude/skills` links)
  for pipeline behavior;
- an agent definition for how one role behaves.

Each tool's own files are edited only by that tool: Claude Code edits `.claude/`, Codex edits
`.codex/`, each skill's `agents/openai.yaml`, and the Codex sections of the skills. A lesson for
the other tool's files goes in the PR description for the owner instead.

State the rule and the reason in a sentence or two. Tighten or replace existing text rather than
appending to it; an instruction file that only grows gets ignored. Keep `CLAUDE.md` under 200
lines and each `SKILL.md` under 500. Check that every file, function and command you name exists.
The repository is public: nothing about the owner's employer, colleagues or private data.

## The branch and the PR

Work in a worktree at `.claude/worktrees/agents-retro`. Run `git fetch --prune origin` from the
main checkout first, so a branch deleted on GitHub no longer shows as present.

If `git worktree list` already shows that worktree, an earlier retro did not finish. When it
holds uncommitted or unpushed work, work from it and continue that retro. Otherwise remove it
with `git worktree remove .claude/worktrees/agents-retro` (never `--force`; if it refuses, find
out why) and go on as below. Then:

- with an open PR for `chore/agents-retro` (`gh pr list --head chore/agents-retro`), add the
  worktree on that branch, add a commit, and extend the PR description;
- with no open PR but the branch still present, locally or on origin, check that its tip in both
  places is the head commit of a merged PR: compare
  `gh pr list --head chore/agents-retro --state merged --json headRefOid` with `git rev-parse`
  of the branch. This holds for every merge method, squash included. If it holds, delete the
  remote branch, if there is one, with
  `gh api -X DELETE repos/jlesak/Intersect/git/refs/heads/chore/agents-retro` (a `git push`
  from the shared checkout is blocked by the owner's main-branch guard, because it is on
  `main`), delete the local branch with `git branch -D chore/agents-retro`, and start over from
  `origin/main`. If it does not hold, ask the owner;
- with no branch, create it from `origin/main`.

Commit with `chore(agents): <what changes for the next run>`, staging explicit paths. Push from
the retro worktree, then open or update the PR titled `chore(agents): setup lessons`, passing the
body as a file under `.agent-runs/` with `--body-file`. Leave the worktree and remove it; the
branch lives on until the owner merges it.

## Claude Code

- Enter the worktree with `EnterWorktree` and its `path`, and leave it with `ExitWorktree` and
  `action: "keep"` before `git worktree remove`.
- `gh *`, `git worktree add *`, `git worktree remove *` and `git push *` are excluded from the
  Bash sandbox; run them as plain commands, without `cd`, `&&` chains, pipes, redirection or
  subshells. A sandboxed `git worktree remove` fails halfway and leaves a damaged worktree.
- Edits under `.claude/` ask the owner for permission. That is intended; wait for the answer.

## Codex

Run a Codex retro in an interactive `codex -p intersect` session. Edits to `.agents` and
`.codex` are protected by `workspace-write` and need a narrow interactive approval, which
`codex exec` cannot surface. Do not use blanket `danger-full-access`. The retro PR remains
open for the owner; agents never merge it.

Use `.claude/worktrees/agents-retro` as the one retro worktree. From a session started in the
main checkout, run `git fetch --prune origin` and perform the shared branch and merged-PR-head
checks. The exact `gh api -X DELETE repos/jlesak/Intersect/git/refs/heads/chore/agents-retro`
rule handles a stale remote branch. `git branch -D chore/agents-retro` prompts for the local
deletion; wait for approval. Create or find the retro worktree, then stop and tell the owner to
start `codex -p intersect -C <absolute-retro-worktree-path>` and invoke `$retro` there. Do not
use per-command `workdir` as a session switch or `--worktree` to create a second checkout.

The worktree-started session checks its root, branch and status, then edits, stages explicit
paths with `git add -- <explicit paths>`, reviews the staged diff, commits and pushes only
`chore/agents-retro`. Leave the PR open. To remove the retro worktree, return to the original
main-checkout Codex session, or start a cleanup-only `codex -p intersect -C
<absolute-main-checkout-path>` session. Request approval for `git worktree remove
.claude/worktrees/agents-retro`; never add `--force`. Prefix rules cannot enforce dynamic
branch or path scope, so check the branch and diff before every git write.
