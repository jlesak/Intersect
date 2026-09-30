---
name: implement-issue
description: Take one GitHub issue of this repository, a feature or a bug, from plan to merged pull request. Planner and reviewer agents draft and critique a plan, the owner approves it on an HTML review page, then implementer, reviewer and verifier agents build and prove it, and the orchestrator ships it. Use only when the owner asks to implement an issue.
argument-hint: "<issue number>"
disable-model-invocation: true
---

# Implement one issue

The issue number is the argument this skill was invoked with. If there is none, ask the owner
which issue to take.

You are the orchestrator. The run is done when the owner has approved the plan, the change is on
its own branch, a fresh reviewer has no remaining blocking findings, the verifier's gate and UAT
pass, the PR is merged with green CI, and the run's worktree is removed.

## Authority

- Invoking this skill is the owner's instruction to commit, push, open a PR and merge it on this
  issue's feature branch once the plan is approved. It overrides the global "never commit unless
  told" rule for this run only, and never extends to `main`.
- You own git. Agents leave their work unstaged; you stage explicit paths and commit.
- Implementation detail is the agents' call. Keep a list of the decisions they report; it goes in
  the PR.

Stop, ask the owner, and wait for the answer when:

- the issue is labelled `needs-info`, `ready-for-human` or `wontfix`, which means it is not ready
  for this pipeline. Any other issue is fine: the owner started the run, and open questions go
  to the plan page;
- the work needs user-visible behavior the approved plan does not cover, or a major technical
  choice it did not make: a new dependency, a data model or migration change, a new or changed IPC
  contract, or a different architecture;
- a gate or CI check is still red after one honest fix attempt;
- a step would lose something git cannot bring back, or reach outside this run: discarding
  uncommitted work, deleting any branch other than this run's, rewriting pushed history, touching
  the shared checkout's files or branch, or touching the owner's real app data.

## Delegation

Each stage is done by its own agent in a fresh context, even though you wait for every result
before you continue. That separation is the point: the planner does not grade its own plan and the
implementer does not review its own code. Never do a stage's work yourself, not even a one-line
fix; resume the agent that owns it. Run one agent at a time, because each stage needs the one
before it.

Agents start without your context. Give each one a self-contained brief with file paths rather
than pasted content, and say what it must return. `stages.md`, next to this file, says what each
brief contains and what comes back. Read it before the first delegation.

If an agent returns before its done criterion is met, resume it and name what is still open.
After two such resumes, treat it as stuck and ask the owner.

## Run state

Keep `.agent-runs/gh<N>/` in the run's worktree (gitignored): `state.md`, `plan.md`,
`po-brief.md` and `pr-body.md`. `state.md` holds the stage, the rounds used, the ids of agents
you will resume, the decision list, the findings, and lessons for the retro; its format is in
`stages.md`. Update it whenever a stage finishes. A stage is finished only when its evidence
exists: a command that passed, or the owner's explicit approval. The run state lives until the
worktree is removed, which happens only after the merge.

To resume a run, for example after a crash or in a new session: when `git worktree list` already
shows this issue's worktree, work from it instead of creating one. Read `state.md` and
`git log origin/main..HEAD`, and continue at the recorded stage; a stage without recorded
evidence is redone. Your tool's section says when recorded agent ids still work; when they do
not, start a fresh agent for the current stage and brief it from the run files, the diff and the
open findings.

## Stages

1. **Worktree.** From the main checkout, run `git fetch origin`, then check that the checkout
   carries the current setup:
   `git diff --quiet origin/main -- AGENTS.md CLAUDE.md .claude .agents docs/agents`, which also
   catches uncommitted edits.
   If it exits non-zero, stop. This skill, the agent definitions, the settings and the
   instructions all load from where the session started, so the run would mix old and new
   setup. Ask the owner to fast-forward the shared checkout and to start the run again in a new
   session.

   If the issue already has a worktree, resume the run as described above. Otherwise: branch
   `fix/gh<N>-<slug>` for a bug, `feature/gh<N>-<slug>` otherwise, with a short kebab-case slug
   from the title. Run
   `git worktree add --no-track -b <branch> .claude/worktrees/gh<N>-<slug> origin/main` as its
   own command, and work from the worktree using your tool's mechanism (see your tool's
   section). From the worktree, symlink the main checkout's `node_modules` with
   `ln -s ../../../node_modules node_modules`; run `npm ci` instead only when
   `package-lock.json` differs from the main checkout's copy. Every agent works in this one
   worktree; never give an agent a worktree of its own.

2. **Plan.** The planner reads the issue and the code and returns a PO brief and a plan as text.
   You write them to `po-brief.md` and `plan.md`.

3. **Plan review.** A fresh reviewer checks the plan against the issue before the owner sees it.
   Send its findings to the resumed planner and review the revision with another fresh reviewer.
   After two rounds, anything still disputed goes on the plan page as an open question.

4. **Owner approval.** Render the PO brief as `.lavish/gh<N>-plan.html` (what goes on the page is
   in `stages.md`). Open it with `npx -y lavish-axi .lavish/gh<N>-plan.html`, then wait for the
   owner with `npx -y lavish-axi poll .lavish/gh<N>-plan.html`. The CLI's own output says what to
   run next and how to reply; follow it over anything you remember about lavish. Send feedback to
   the resumed planner, re-review a revision that changes behavior or approach, update the page,
   and poll again until the owner approves explicitly. Then end the lavish session. Have the
   resumed planner fold the owner's answers into the brief, so that it records decisions instead
   of open questions and changes nothing else, save it to `po-brief.md`, and post it to the
   issue: `gh issue comment <N> --body-file .agent-runs/gh<N>/po-brief.md`. The approval covers
   what the brief says, nothing more.

5. **Implement.** If the approved plan adds, removes or upgrades a dependency, first give the
   worktree its own install: delete the `node_modules` link and run `npm ci`. Otherwise
   `npm install` writes through the link into the shared checkout's modules. The implementer
   builds the approved plan test-first and owns the unit and integration tests. For a bug it
   first reproduces the bug in a failing integration test. It returns with typecheck, lint and
   unit tests green and everything unstaged. Commit its work.

6. **Code review.** A new reviewer instance for every round. It gets the issue first, then the
   approved brief and plan, then the diff. From the second round on, tell it what earlier rounds
   found and how each was fixed, and to assume the newest fix introduced its own hole. Pass the
   blocking findings to the resumed implementer, which fixes each or rebuts it with evidence; a
   rebuttal goes to the next reviewer together with the finding. Commit each round's fixes. The
   review ends with the first round that has no blocking findings. Non-blocking findings go into
   `state.md` and the PR body and never start a round. A run gets three review rounds in total,
   including the rounds after verifier and CI fixes; if the third still has blocking findings,
   or a later stage needs a round when all three are used, ask the owner.

7. **Verify.** The verifier checks the result black-box against the acceptance criteria: the full
   gate including e2e, a UAT pass through the `run-app` skill, and mutation testing of the new
   tests. It reports findings and leaves the tree exactly as it found it. Send findings to the
   resumed implementer. Any code change then gets a fresh reviewer round, which counts toward
   the three, and the resumed verifier confirms its findings are closed and the gate is still
   green. That re-check is the last verification round; findings still open after it go to the
   owner.

8. **Ship.** Push with `git push -u origin <branch>`. Write the PR body to
   `.agent-runs/gh<N>/pr-body.md` (title and body in `stages.md`) and open the PR with
   `gh pr create --title "<title>" --body-file .agent-runs/gh<N>/pr-body.md`. Wait for CI with
   `gh pr checks <PR> --watch`; checks can take a minute to register after the PR opens, so if
   it finds none, run it again. A failed e2e job gets one re-run
   (`gh run rerun <run-id> --failed`). Any other red check, or e2e failing twice, is handled like
   a red gate: one fix through the implementer, with a fresh review round for any code change,
   then ask the owner. Once CI is green, check `gh pr view <PR> --json state` first: on a resumed
   run the PR may already be `MERGED`, and merging again deletes nothing. In that case record it
   and delete the remote branch with
   `gh api -X DELETE repos/jlesak/Intersect/git/refs/heads/<branch>`. Otherwise merge from the
   worktree with
   `gh pr merge <PR> --merge --delete-branch --repo jlesak/Intersect`. With `--repo`, gh deletes
   the remote branch and leaves local branches alone; without `--repo`, `--delete-branch` makes
   gh try to check out `main`, which the shared checkout holds. gh prints nothing on success
   outside a terminal, so confirm with `gh pr view <PR> --json state,mergeCommit` and record
   `stage: merged` and the merge commit in `state.md`.

   If the merge is refused because the branch conflicts with `main`, run `git fetch origin`, then
   `git merge origin/main` in the worktree (never rebase), have the resumed implementer resolve
   the conflicts in the working tree, commit the merge, and run a fresh review round, which
   counts toward the three. Handle any other refusal through the agents the same way. Then push
   and wait for CI again.

9. **Clean up.** Take the lessons and the decision list from `state.md` now, since it is deleted
   with the worktree. Return to the main checkout (see your tool's section), remove the worktree
   with `git worktree remove .claude/worktrees/gh<N>-<slug>` (never `--force`; if it refuses,
   find out why), and delete the local branch with `git branch -D <branch>`. Never `git pull` or
   switch branches in the shared checkout. In the Claude sandbox that delete prints
   `could not lock config file .git/config` and still deletes the branch; do not retry it.

10. **Retro.** When the run taught something about this setup (a wrong turn, a lost round, a fact
    an agent was missing, an instruction that misled), run `git fetch origin` and read the retro
    skill with `git show origin/main:.agents/skills/retro/SKILL.md`, because the shared
    checkout's copy may be behind. Follow it with those lessons. Otherwise skip it.

Finish with a short report to the owner: the PR and merge commit, what changed for the user, the
decisions the agents made, the non-blocking findings left open, any follow-up issues worth
filing, and a reminder that the shared checkout stays behind `origin/main` until they
fast-forward it.

## Claude Code

- The agents are `planner`, `implementer`, `reviewer` and `verifier` in `.claude/agents/`. Spawn
  each with the Agent tool and its `subagent_type`. Their definitions pin the model and effort, so
  pass no `model`. Never pass `isolation: "worktree"`: an agent must work in this run's worktree,
  which it inherits as its working directory.
- Right after `git worktree add`, or when you resume a run whose worktree exists, call
  `EnterWorktree` with `path: ".claude/worktrees/gh<N>-<slug>"`. That moves your working
  directory and write access there, and the agents you spawn afterwards work there too. Agent
  definitions, settings, CLAUDE.md and this skill's text stay as they were loaded where the
  session started, which is why stage 1 requires an up-to-date shared checkout. To go back to the
  main checkout, call `ExitWorktree` with `action: "keep"`; it never removes a worktree entered by
  path, so the `git worktree remove` step still applies.
- Agents run in the background and you get a notification when each one finishes. Wait for it;
  never report or act on a result you have not received.
- Resume an agent with `SendMessage` to its agent id, and record the ids in `state.md`. An id
  works only in the session that spawned the agent, including that session reopened with
  `claude --resume`; a new session starts fresh agents. A new reviewer each round is a new Agent
  call.
- `lavish-axi poll` and `gh pr checks --watch` outlast the 10-minute Bash limit. Run each with
  `run_in_background: true` and act on its completion. If a poll dies or times out, run it again;
  queued feedback is not lost.
- `gh *`, `npx -y lavish-axi *`, `npm run e2e*`, `npm test*`, `npx vitest run *`, `npm ci`,
  `git worktree add *`, `git worktree remove *` and `git push *` are excluded from the Bash
  sandbox. They need the network, the npm cache, the keychain or local ports, or they write a
  worktree's protected `.claude/` files. The exclusion only applies to a plain command, so run
  these without `cd`, `&&` chains, pipes, redirection or subshells. A sandboxed
  `git worktree remove` fails halfway and leaves a damaged worktree. The agent definitions say
  the same for the test commands.
- `git merge origin/main` and `npm install` are not excluded. A merge that touches `.claude/`
  fails in the sandbox with "unable to unlink old", and `npm install` needs the network; retry
  either outside the sandbox, which goes through the owner's normal permission flow.

## Codex

Start Codex for this repository with `codex -p intersect`. The owner installs that user-level
profile; project config cannot filter global skills in CLI 0.156.1. The issue number arrives in
the owner's invoking message, not through `$ARGUMENTS`. The owner removes the registered GitNexus
index after this setup merges, making the global hook a no-op for Intersect. Check that
`~/.codex/intersect.config.toml` exists before continuing: CLI 0.156.1 accepts `-p intersect`
without an installed profile and gives no warning, leaving global GitNexus and superpowers
skills visible. Stop and ask the owner to install the profile if it is missing.

The pipeline has two starts. When `$implement-issue <N>` is invoked from the shared checkout,
run stage 1's `git fetch origin` and exact parity check
`git diff --quiet origin/main -- AGENTS.md CLAUDE.md .claude .agents docs/agents`. If it fails,
stop as the shared stage says. Otherwise find or create `.claude/worktrees/gh<N>-<slug>` with
`git worktree add --no-track -b <branch> .claude/worktrees/gh<N>-<slug> origin/main` for a new
run, and write
`.agent-runs/gh<N>/state.md` there in the `stages.md` format, recording the issue, kind,
branch, relative and absolute worktree paths, `stage: plan` for a new run, and no agent ids.
Preserve existing state when resuming. Do not delegate or run
later stages in this session. Tell the owner the exact command
`codex -p intersect -C <absolute-worktree-path>` and to invoke `$implement-issue <N>` again in
that new session. `--worktree` creates another checkout and is not this handoff.
If the shared-checkout session's sandbox blocks writing the run state under `.claude/worktrees`,
request a narrow interactive approval for that write before stopping; do not start delegation
without durable state.

In the worktree-started session, confirm the Codex project root and `git rev-parse --show-toplevel`
are this issue worktree and that its branch matches `state.md`. Read this worktree's `AGENTS.md`,
skill and `stages.md`; rehydrate from `state.md` and `git log origin/main..HEAD`. If the lockfiles
match, run exactly `ln -s ../../../node_modules node_modules` from this worktree when it lacks
`node_modules`; if they differ, run `npm ci` here instead. Then continue at the first stage
without recorded evidence.
Only this session delegates. A new session cannot resume the earlier session's agent ids; brief
fresh agents from the run files, diff and open findings. Do not use per-command `workdir` or
shell `cd` as a substitute for starting Codex in the worktree: those do not reload project
config, rules or agents or change the session sandbox root.

Spawn the named `planner`, `reviewer`, `implementer`, and `verifier` custom agents with the
self-contained briefs in `stages.md`. Delegate every stage for a fresh context even though the
next step waits on it; this workflow overrides Codex's general advice against delegating
blocking work. Use `wait_agent` before consuming a result. Resume the planner or implementer
with the runtime's follow-up/resume action and its recorded id. Close each plan reviewer after
collecting its findings. Close the planner immediately after the owner approves and the final
plan is recorded, before spawning the implementer. Close each code reviewer after its report.
Keep only the implementer through fix rounds and the verifier through its last verification;
close both when no further turn is needed. Before every spawn, check that fewer than three
subagent threads remain open and record current ids in `state.md`. A fresh reviewer is a new
thread every round. Parent runtime overrides can replace an agent's sandbox, so the planner's
and reviewer's written no-edit constraints still apply.

From the worktree session, stage only explicit paths from a reviewed `git status` and diff with
`git add -- <explicit paths>`; never stage the `node_modules` symlink. Inspect the staged diff
before every commit. Push only this run's branch with `git push -u origin <branch>`. If a
conflict blocks the PR merge, run `git fetch origin` and then `git merge origin/main` here;
resume the implementer for conflicts, commit the merge, and request a fresh review. If all
three code review rounds are used, ask the owner instead of starting another round. After green
CI, check `gh pr view <PR> --json state` before merging. If it is already `MERGED` on a resumed
run, record that fact and request approval for
`gh api -X DELETE repos/jlesak/Intersect/git/refs/heads/<branch>` to remove its remote branch.
Otherwise merge here with `gh pr merge <PR> --merge --delete-branch --repo jlesak/Intersect`;
the `--repo` flag prevents gh from trying to switch this worktree to `main`. Confirm with
`gh pr view <PR> --json state,mergeCommit` and record `stage: merged` and the commit in
`state.md` before ending the worktree session. Do not use `git push` to delete a branch.

Cleanup runs from a Codex process started in the main checkout, after the merge. Return to the
original shared-checkout session or start `codex -p intersect -C <absolute-main-checkout-path>`
for a cleanup-only request naming issue <N>. Read the worktree's `state.md`, preserve its lessons
and decisions for the report and retro, verify the recorded PR is merged, then request approval
for `git worktree remove .claude/worktrees/gh<N>-<slug>` and
`git branch -D <branch>` separately. Never use `--force` on worktree removal. This cleanup-only
session does not repeat stage 1 or delegate. Each command is `prompt`, so wait for the owner's
decision; do not bypass a refusal. A `codex exec` session cannot surface these approvals. If
there are lessons, continue into the retro bootstrap in this same main-checkout session and
write its self-contained brief under the retro worktree's `.agent-runs/` before stopping;
the removed issue worktree cannot serve as a later source.

Prefix rules cannot validate a dynamic branch, refspec destination, path list or trailing flag.
The allowed prefixes therefore also match `git add -- src/main.ts .`,
`git push -u origin feature/x --force`, `git push -u origin feature/x:main`, and
`gh pr merge <PR> --merge --delete-branch --repo jlesak/Intersect --admin`. Never use those
forms. The workflow permits pushes only to this run's feature or fix branch; the rule cannot
enforce that scope, so an erroneous refspec could affect another unprotected branch. The owner
accepts this residual risk with staged-diff review before commits, explicit run-branch checks
before pushes, and server-side `main` protection with `enforce_admins` and both CI checks. A
direct push or admin merge to `main` is rejected there even for an admin. If another command
needs approval, use an interactive session and do not replace refusal with a shell wrapper or
a broader permission mode. `gh api -X DELETE` is prompted for feature and fix refs because
the endpoint and branch are one argv token; the retro deletion also prompts in the effective
policy despite its exact allow rule, since Codex applies the stricter decision.

Keep `npx -y lavish-axi poll <page>` attached to the active turn in a tracked command session.
Wait on that session until it exits; restart the poll if it exits without owner feedback, and
never infer approval from elapsed time. Likewise run `gh pr checks <PR> --watch` in a tracked
session, wait for its final result, and retry when checks have not registered yet. Do not detach
either wait into an untracked shell process. Run state stays under `.agent-runs/`, because
`.git`, `.agents`, and `.codex` are protected by `workspace-write`.
