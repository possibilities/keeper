## Overview

The escalation-guard's `isOpenFilesInPagerAbbrev` predicate sets its
unambiguous-prefix floor at `"--open".length` (6 chars), two characters too
long. Git's real minimum unambiguous prefix for `--open-files-in-pager` is
`--op` (4 chars), so `git grep --op=<cmd>` and `--ope=<cmd>` still reach git's
exec alias and run a caller-named program from an allowlisted read subcommand
— the exact arbitrary-exec vector the source epic set out to close, still live
for the fail-closed diagnosis role. This follow-up lowers the floor to git's
true minimum and adds the missing deny-case coverage.

## Acceptance

- [ ] `git grep --op=<cmd>` and `--ope=<cmd>` (glued and space-separated) are
      denied for the diagnosis role.
- [ ] The `--o` ambiguity boundary is respected (git itself rejects it as
      ambiguous, so a deny there is a harmless over-block, not a correctness
      requirement).
- [ ] The predicate's doc-comment no longer asserts the false `--open`-floor
      premise that produced the off-by-two.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Empirically confirmed `git grep --op=`/`--ope=` reach `fatal: cannot exec` while the `>= "--open".length` (6) floor at escalation-guard.ts:490-496 lets them pass — a live arbitrary-exec bypass for the fail-closed diagnosis role. |
| F2 | merged-into-F1 | .1 | F2 (missing `--op`/`--ope` deny-case tests) is the test side of F1's floor off-by-two, so it folds into F1's task — the same edit lowers the floor and adds the deny cases. |

## Out of scope

- The `--output` file-write branch and the `-O` short-cluster regex — verified
  unchanged and unaffected by this gap.
- The `-c` / `--config-env` config-injection layer — a separate guard, not
  touched here.
