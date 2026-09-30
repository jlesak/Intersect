# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues in `jlesak/Intersect`. The repository
is public, so an issue must not carry credentials, internal hostnames, or anything about the
owner's employer or colleagues.

## Conventions

- Use the `gh` CLI (`gh issue view <N> --comments`, `gh issue create`, `gh issue comment`).
- Read an issue's complete body, comments, and labels before acting on it. Comments can carry
  decisions that override the body, such as an approved plan brief.
- Publish implementation issues in dependency order so later issues can reference real blocker
  numbers.
- Do not close or modify a parent issue when decomposing it into implementation issues.

## Skill terminology

When a skill says "publish to the issue tracker", create a GitHub issue in `jlesak/Intersect`.

When a skill says "fetch the relevant ticket", read the GitHub issue including comments and
labels.
