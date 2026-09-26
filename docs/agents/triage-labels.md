# Triage labels

The engineering skills use five canonical triage roles. This repository uses the same strings in
GitHub.

| Canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an autonomous agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation or interaction |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill refers to an AFK-ready issue, apply `ready-for-agent`.

## Other labels

- Type: `bug` for broken behavior, `enhancement` for new or changed behavior.
- Area: a `feature:<slice>` label (`gh label list` shows the current set) when the issue sits in
  one slice. Do not create new labels without the owner's approval.
- Review batches such as `ux-review` and `watchtower-review` mark issues accepted in one product
  review; only the owner adds them.
