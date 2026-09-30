---
name: write-issue
description: Turn an idea, a feature request or a bug report for Intersect into a GitHub issue that the implement-issue pipeline can take without further questions, or triage an existing issue, such as one labelled needs-triage or needs-info, into that shape. Publishes only after the owner approves the draft. Use when the owner asks to write, file, draft or triage an issue.
argument-hint: "<idea, bug report or issue number>"
disable-model-invocation: true
---

# Write or triage an issue

The input is the argument this skill was invoked with, together with anything the owner said
around it: an idea or a bug report, or the number of an existing issue to triage. If there is
neither, list the open issues labelled `needs-triage` and those labelled `needs-info`, and ask
the owner which one to take.

The result is one issue in `jlesak/Intersect` that an agent can plan from without asking what was
meant, published only after the owner has approved the draft in this conversation. An idea
becomes a new issue; a triaged issue is rewritten and relabelled in place. A request that is
really several independent changes becomes several new issues, in dependency order. A triaged
issue that splits this way stays as the parent: leave its body and labels as they are, comment
on it with links to the new issues, and ask the owner whether to close it.

## What the issue says

- **Title**: the user-visible outcome, as a plain sentence.
- **Problem**: who runs into what, in which view, and why it matters for the owner's daily work.
- **Desired behavior**: what the user sees and does afterwards. For a bug: steps to reproduce,
  expected against actual behavior, and where it happens (installed app or dev build, and the
  commit or version).
- **Acceptance criteria**: numbered, each one observable in the running app or checkable by a
  test, including the edge cases that matter (empty state, restart, narrow window, offline
  services).
- **Out of scope**: what this issue deliberately does not change.
- **Notes**: where the behavior lives in the code today, related issues, and constraints from
  `docs/agents/product.md`.
- **Labels**: as `docs/agents/triage-labels.md` describes. `ready-for-agent` only when nothing is
  left for the owner to decide; otherwise `needs-triage` or `needs-info`, with the open questions
  listed in the body.

## How to get there

Read enough of the code to make the criteria accurate: what exists today, where the behavior
lives, and what the change would touch. Check `docs/agents/product.md`: if the idea was declined
before, say so and draft only if the owner still wants it. Search for duplicates with
`gh issue list --state all --search "<terms>"`.

To triage an existing issue, read it in full with its comments and labels
(`gh issue view <N> --comments`). Keep every fact the reporter and the commenters gave, fill the
gaps from the code, and keep the original text at the end under **Original report** unless the
owner says to drop it. If the owner decides it will not be done, label it `wontfix` and close it
as not planned (`gh issue close <N> --reason "not planned"`), and only on their word.

Ask the owner only what you cannot find out yourself. What the feature should do is theirs to
decide; how to build it is not a question for the issue.

The repository is public. Keep credentials, internal hostnames, and anything about the owner's
employer, colleagues or private data out of the issue.

Show the draft in the conversation: title, labels and body, and for a triaged issue what changed.
After the owner approves it, write the body to a temporary file outside the repository and
publish it:

- a new issue with `gh issue create --title "<title>" --body-file <file> --label <label>`,
  repeating `--label` for each label;
- a triaged issue with
  `gh issue edit <N> --title "<title>" --body-file <file> --add-label <new> --remove-label <old>`,
  repeating the label flags as needed.

Report the issue URL.

## Claude Code

`gh *` is excluded from the Bash sandbox. Run `gh` as a plain command, without `cd`, `&&`
chains, pipes, redirection or subshells, or the exclusion does not apply.

## Codex

Start Codex here with `codex -p intersect`. The idea, bug report, or existing issue number
arrives in the owner's invoking message; Codex does not substitute `$ARGUMENTS`. Check that
`~/.codex/intersect.config.toml` exists first: CLI 0.156.1 silently accepts a missing profile
and otherwise leaves global skills visible. If it is absent, stop and ask the owner to install
it. Use the
project rules for plain `gh issue list/view` and `gh label list`. After the owner approves the
displayed draft, use `gh issue create` for a new issue or `gh issue edit` for triage; close an
issue as not planned only after the owner explicitly decides that outcome. Keep the body file
outside the repository as the shared instructions require. An unmatched command may need a
narrow interactive approval; non-interactive `codex exec` cannot surface one.
