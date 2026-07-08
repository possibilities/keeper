## Overview

The diagnosis-role git classifier in escalation-guard shipped with two boundary
defects and a coverage gap. It over-blocks a legit combined-diff read (`git log/show
-c --format=...`) because the config-injection scan does not stop at the subcommand,
and it still lets an allowlisted read subcommand reach arbitrary program execution via
`git grep --open-files-in-pager=<cmd>`. This follow-up corrects the over-block, closes
that exec vector, and regression-locks the ref-classifier deny/allow cases — all in the
one hook file that owns the escalation git boundary.

## Acceptance

- [ ] `git log -c --format=...` / `git show -c --format=...` pass for a diagnosis role while a real global `-c <name>=<value>` (incl. the pre-subcommand reorder form) still denies.
- [ ] `git grep --open-files-in-pager=<cmd>` (and the exec-bearing flag family it represents) is denied for a diagnosis role.
- [ ] The ref-classifier deny/allow cases are locked by table tests.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | gitConfigInjection scans the whole segment, over-blocking `git log/show -c --format=...` — a legit combined-diff read on the diagnosis boundary. |
| F2 | culled | — | Comment-only nit: `(F1)/(F2)` opaque labels; prose stands alone, no functional impact. |
| F3 | kept | .1 | A delete flag (`-D`) in a filter-value slot after a `--list` filter is denied but untested; lock the filter-value defense so a ref delete cannot slip the diagnosis guard. |
| F4 | kept | .1 | `--unset-upstream` is in MUTATING_BRANCH_FLAGS but the one mutating flag with no deny-table case. |
| F5 | merged-into-F1 | .1 | F5 (add `git log -c --format` allow-table test) regression-locks the read F1 un-blocks — same root cause as F1, folded in. |
| F6 | kept | .1 | `grep` is allowlisted, so `git grep --open-files-in-pager=<cmd>` runs an arbitrary program for a diagnosis role — a real exec bypass of this read boundary. |

## Out of scope

- Any git-boundary rework outside the diagnosis (read-only) role — write-capable roles keep full git.
- The `(F1)/(F2)` test-comment relabel (F2) — culled as a cosmetic nit.
