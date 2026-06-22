## Overview

The cross-repo id resolver returns a typed `no_project` outcome when `--project`
points at a directory with no planctl board, and the done/show/cat verbs render
it as an actionable "No planctl project found" message. refine-context's bespoke
not-found branch drops that reason and emits a misleading "Epic not found"
instead, sending an operator who fat-fingered `--project` hunting for a missing
epic. This is a small UX-correctness gap on the documented escape hatch, fixed by
one typed branch and its regression test.

## Acceptance

- [ ] refine-context renders the `no_project` reason as a project-missing message consistent with done/show/cat.
- [ ] A test exercises the `no_project` path so the parity gap cannot silently reopen.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | kept   | .1 | refine_context.ts:70-79 special-cases only `ambiguous` and falls through to "Epic not found", dropping the `no_project` message done/show/cat render correctly. |
| TG1 | merged-into-F1 | .1 | TG1 (the `no_project` reason untested for any verb) is the regression test for the F1 fix and lands in the same task as F1. |
| F2  | culled | — | show.ts:107-114 unreachable "Task not found" branch is harmless fail-closed defense-in-depth; auditor says no action required. |
| F3  | culled | — | cli.ts:24 redundant comment restates `readPositional` behavior, states no hidden invariant; style nitpick. |
| TG2 | culled | — | `done --project` from a neutral cwd exercises shared bypass logic already covered via show; low-risk. |
| TG3 | culled | — | number-only `fn-N` through `resolveEpicGlobally` integer-matching is shared logic; low-risk gap. |

## Out of scope

- The unreachable show.ts task-not-found branch and the redundant cli.ts comment (culled — code-cleanliness, no user impact).
- Additional `--project` / number-only coverage on shared resolver paths (culled — low-risk, already exercised via other shapes).
