# Stage briefs

What the orchestrator hands each agent and what it gets back. An agent has none of your context,
so every brief stands on its own: the issue number, the worktree path, the paths of the files it
must read, and what it must return. Pass findings and owner feedback verbatim; your summary of
them loses exactly the detail that matters.

## Planner

Brief: the issue number, whether it is a bug or a feature, and on a revision the owner's feedback
and the reviewer's findings verbatim. Say that it runs inside the implement-issue pipeline, so it
does not interview the owner or invoke grill-me: open questions go in the PO brief, and the owner
answers them on the plan page.

Returns two sections as text, which you write to the run state:

- `po-brief.md`, for the owner, who decides functionality and major technical direction and does
  not read code: what the user will see and do differently; UX decisions; major technical choices
  with the alternative considered; what is out of scope; open questions, each with a recommended
  answer.
- `plan.md`, for the implementer: the approach; the files and modules touched and why; data,
  migration and IPC changes; for each acceptance criterion the test that proves it and at which
  level; for a bug, the suspected cause and the failing test that reproduces it; risks; suggested
  follow-up issues.

## Plan reviewer

Brief: the issue number (read it first, with comments), then the paths of `po-brief.md` and
`plan.md`. Ask whether the plan meets every acceptance criterion and the issue's intent, whether
it contradicts the issue, `docs/agents/product.md` or the code as it is, and whether each planned
test would fail if its behavior broke.

Returns findings, or "no findings".

## Implementer

Brief: the issue number, the paths of the approved `po-brief.md` and `plan.md`, bug or feature,
and the rule that all work stays unstaged. On a resume: the blocking findings verbatim, each
with its source (reviewer round n, verifier, CI). For a merge conflict: the conflicted paths,
and that it resolves them in the working tree, keeping the intent of both sides, and leaves the
merge commit to you.

Returns: files changed; tests added or changed and what each proves; typecheck, lint and unit test
results with counts; implementation decisions not dictated by the plan, one line each with the
reason; rebutted findings with their evidence; questions only the owner can answer.

## Code reviewer

Brief, in this order: the issue number; the paths of the approved `po-brief.md` and `plan.md`;
the change to review, which is `git diff origin/main...HEAD` plus anything uncommitted; the round
number. From round two on, add the earlier rounds' findings and how each was fixed or rebutted,
and ask it to assume the newest fix introduced its own hole.

Returns findings with location, a concrete failure scenario and whether each blocks the merge,
or "no findings". Only blocking findings go back to the implementer.

## Verifier

Brief: the issue number, the path of the approved `po-brief.md`, and the implementer's list of new
and changed tests. On a resume: which of its findings were addressed and how.

Returns: a verdict; gate results with counts, including any e2e re-run; for each acceptance
criterion what was driven in the app, what was observed and the screenshot paths; mutants tried
and killed, and each survivor with its mutation; findings; confirmation that the working tree is
as it found it.

## The plan page

`.lavish/gh<N>-plan.html` is the PO brief made easy to decide on, not the technical plan
re-typeset:

- open questions first, each with the recommended answer and the alternative;
- then what changes for the user, the UX decisions, and the major technical choices;
- out of scope;
- the technical plan last, collapsed, for reference.

When the change alters an existing screen, a screenshot of that screen today (captured with
`run-app`) says more than a description. `npx -y lavish-axi playbook plan` has layout guidance.
Style the page with the app's own tokens from `src/renderer/src/shared/ui/theme.css`.

## Commits and the pull request

Commits follow the repository's convention, `type(scope): subject`, where the type is `feat`,
`fix`, `test`, `refactor` or `chore`, the scope is the slice or area, and the subject says what
changed for the user. One commit per coherent change: the implementation, then each round of
fixes. Stage explicit paths taken from `git status`, never `node_modules`.

PR title: a plain sentence naming the user-visible change. Body, concise:

- `Closes #<N>.`
- what changed for the user, one short paragraph or a few bullets;
- the implementation decisions the agents made, one line each with the reason;
- what review and verification found, and the commits that fixed it;
- non-blocking findings left open, each as a known gap or a suggested follow-up issue;
- tests added, and verification evidence: counts for vitest, typecheck, lint and e2e, and what
  the UAT covered.

## `state.md`

```text
issue: #<N> <title>
kind: feature | bug
branch: feature/gh<N>-<slug>
worktree: .claude/worktrees/gh<N>-<slug>
stage: plan | plan-review | approval | implement | review | verify | ship | merged | retro | done
rounds: plan review <n> of 2, code review <n> of 3, verify <n> of 2
agents: planner=<id> implementer=<id> verifier=<id>
approved: <date>, <link to the issue comment>
pr: <number>
merge: <merge commit>
decisions:
- <decision> - <reason>
findings:
- [open|fixed|rebutted|non-blocking] <source>: <finding>
lessons:
- <what went wrong or cost a round, and what would have prevented it>
```
