---
name: implement-issue
description: Takes one GitHub issue from exploration through TDD implementation, adversarial review, the e2e gate, PR and merge, keeping STATE.md current so a fresh session can resume.
argument-hint: "<issue number | next>"
disable-model-invocation: true
allowed-tools: Bash(git commit:*), Bash(git push:*), Bash(gh pr:*)
---

# Implement one issue

Target: `$ARGUMENTS`. With `next`, pick the highest-priority open issue that is ready to work
on (see `docs/agents/issue-tracker.md` for labels) and confirm the pick before starting.

This repository is mine alone, so this pipeline may commit, push, open a PR and merge it. That
permission belongs to this skill only: invoking it is the instruction to commit. The guard
still refuses commits on `main`, which is correct - work happens on a branch.

## Pipeline

Copy this checklist into your first message and tick items as they complete.

1. **Understand** - read the issue and its linked PRD. Explore the touched area with an
   `analyst` subagent rather than reading half the repo into this context. Restate the
   acceptance criteria in your own words and flag anything ambiguous now, not later.
2. **Branch** - `feature/gh<NN>-<slug>` or `fix/gh<NN>-<slug>` from an up-to-date `main`.
3. **Implement under TDD** - test first, minimum code, refactor. Delegate to `implementer`
   subagents when the change spans several files; do a one-file change yourself.
4. **Review** - one fresh-context reviewer subagent briefed to argue the change is wrong:
   correctness, the acceptance criteria, regressions in the surrounding area, test quality.
   Fix what survives scrutiny.
5. **Gate** - `npm run typecheck`, `npm run lint`, `npm test`, then `npm run e2e`. All green
   before anything leaves the machine. If e2e fails, re-run it once: this suite has a known
   flake. A second failure is a real failure - investigate, never re-run a third time.
6. **Ship** - commit with a message that says what changed for a user, push, open the PR with
   `gh pr create` referencing the issue, wait for CI, merge when green.
7. **Close out** - confirm the issue closed, update `STATE.md`, and report. Then stop: picking
   up the next issue is a new decision, not a continuation.

## STATE.md

Keep `STATE.md` at the repo root current so a new session resumes with "read STATE.md and
continue" instead of a hand-written handoff:

```
issue: gh48 - PR size and description
branch: feature/gh48-pr-size
step: 5 (gate)
done: typecheck, lint, unit tests green (evidence: 142 passed)
next: npm run e2e
open: none
```

A step is done only when its command actually passed. Writing "done" before the evidence
exists is how a resumed session builds on a false premise.

## Rules

- One issue per run. Scope creep found along the way becomes a new issue, not extra commits.
- Never weaken or skip a test to get the gate green.
- If the gate cannot pass and the reason is not obvious after one honest attempt, stop and
  report rather than grinding.
