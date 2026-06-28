## Overview

A GO panel cleared the worktree path for a supervised canary and named four
non-blocking residual edges. This closes them so the canary lands with no loose
ends: recover pass-2 silently swallows a `push-unconfirmed` result (no case, no
exhaustiveness guard); a `local-timeout` merge can leave `MERGE_HEAD` behind; a
few inline comments still describe the non-ff degrade as a retry-skip (it ships
as a visible sticky); and a few merge-path read ops still lack a local timeout.
None affect canary correctness — this is the clean-landing pass.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts`

## Acceptance

- [ ] recover pass-2 handles `push-unconfirmed` (correctly-scoped retry-skip) and has a default exhaustiveness guard
- [ ] a `local-timeout` merge leaves no `MERGE_HEAD` residue; merge-path reads are timeout-bounded
- [ ] no inline comment still describes the non-ff degrade as a retry-skip

## References

- A blind multi-model GO panel (ran the suite: 354 pass / 0 fail) named B1 (pass-2 push-unconfirmed swallow + no exhaustiveness guard), B2 (local-timeout MERGE_HEAD residue), B3 (stale non-ff comments), B4 (unbounded merge-path reads) as the only remaining supervise-able residuals. Builds on fn-993.
