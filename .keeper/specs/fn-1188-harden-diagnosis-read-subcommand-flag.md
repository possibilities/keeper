## Overview

The escalation-guard's read-only diagnosis boundary still leaks two exec/write
vectors on allowlisted read subcommands. `git grep`'s exec alias is reachable
via short-option bundling (the deny only matches a token that begins with `-O`),
and `git log/diff --output=<file>` writes an arbitrary file — both let a
diagnosis role (`unblock`/`resolve`) escape read-only. This continues the
diagnosis-role git-boundary hardening series by closing both in
`gitReadSubcommandExecFlag`.

## Acceptance

- [ ] Bundled short-option `-O` clusters (`git grep -nO<pager>`, `-iO<pager>`, any `-<flags>O<pager>`) are denied for diagnosis roles.
- [ ] `git log --output=<file>` / `git diff --output=<file>` (and glued/space forms) are denied for diagnosis roles as an arbitrary file-write vector.
- [ ] Un-bundled reads and legitimate flags (diff/log benign `-O` order-file) stay allowed — no over-block.
- [ ] Deny-case tests cover the bundled `-O` form and the `--output=` form.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Reproduced live: `git grep -nO<pager>`/`-iO<pager>` fire the pager because escalation-guard.ts:508 `arg.startsWith("-O")` matches only token-start and misses git's bundled short-option cluster. |
| F2 | merged-into-F1 | .1 | F2 (missing deny-case test for the bundled short-option form) is the test half of F1's fix — the same root cause as F1 — so it folds into F1's task. |
| F3 | kept | .1 | Reproduced live: `git log/diff --output=<file>` write an arbitrary file for a read-only role; gitReadSubcommandExecFlag screens only `-O`/`--open-files-in-pager`. Same file and theme as F1. |

## Out of scope

- The bounded `gitConfigInjection` refactor and the valued-global set (audited sound, no finding).
- Write-capable roles (deconflict/repair) which keep the unchanged full-git early return.
