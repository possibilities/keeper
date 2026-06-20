## Overview

The branch-guard's `modeFlags` set in `plugins/keeper/plugin/hooks/branch-guard.ts`
lists only short flag forms (`-d`/`-D`/`-m`/`-M`/`-c`/`-C`), which produces two
out-of-sync behaviors: short `-c`/`-C` copy-create is silently ALLOWED (a real
subagent branch-create bypass of the very control this guard exists to enforce),
while long `--delete`/`--move`/`--copy` forms get DENIED when followed by a
positional (a false-deny that blocks legitimate worker `git branch --delete old`).
This is a bug-fix to reconcile short/long parity and make the copy-create policy a
deliberate, tested decision rather than an accident of which forms made the set.

## Acceptance

- [ ] Short and long flag forms classify identically (no `-c`/`--copy` or `-d`/`--delete` split)
- [ ] `git branch -c <new>` / `-C <base> <new>` copy-create is blocked (it creates a branch ref)
- [ ] Legitimate long-form `git branch --delete old` / `--move old new` no longer false-deny
- [ ] Regression rows pin both the newly-blocked copy-create and the newly-allowed long-form mode commands

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | branch-guard.ts:121 modeFlags includes -c/-C so git branch -c <new> copy-create is allowed (returns false) — a real subagent branch-create bypass; long --copy is denied, an asymmetry. |
| F2 | culled | — | branch-guard.ts:130 i++ operand-skip is correct today; request only pins already-correct behavior against a hypothetical future refactor — no current defect or user impact. |
| F3 | merged-into-F1 | .1 | F3 (--delete/--move long forms false-deny a positional at branch-guard.ts:133) is the over-strict face of F1's short-form-only modeFlags root cause; folded into F1's parity-pass task. |

## Out of scope

- The space-separated `--set-upstream-to origin/main` operand-skip test (F2) — behavior is correct as shipped; deferred.
- The two classifier bypasses already closed by fn-853 (`--orphan=`/`--create=` equals forms, `-f`/`--force`-prefixed positional scan).
