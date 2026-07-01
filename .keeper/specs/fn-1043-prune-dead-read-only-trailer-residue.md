## Overview

The single-value read-contract change removed the read-only `plan_invocation`
trailer but left dead residue behind: an exported `trailerProjectRoot()`
helper with zero callers, plus a test comment that narrates the now-removed
trailer mechanism. Because the helper is exported, biome's unused-symbol lint
will not flag it, so it lingers as a latent maintenance hazard the next reader
could mistake for a live seam and rewire. This is a small prune to keep the
plan plugin's strict no-tombstone / prune-on-touch doc discipline honest.

## Acceptance

- [ ] The orphaned exported dead helper is deleted and typecheck/lint stay green
- [ ] No comment or test narrates the removed read-only-trailer mechanism

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | project.ts:302 trailerProjectRoot is exported dead code with zero callers; lint cannot catch an exported symbol, so it misleads the next reader. |
| F2 | merged-into-F1 | .1 | F2 (saga-close-preflight.test.ts:410-415 comment naming trailerProjectRoot) shares F1's removed-trailer root cause; deleting F1's helper forces re-anchoring the comment, so it folds into F1's task. |
| F3 | culled | — | detect.ts:44 duplicates project.ts:80 but the strings are identical today; the drift is hypothetical with no test-linked correctness gap. |
| F4 | culled | — | readIntOption accepting 0x10/1e2 still yields a valid positive int with no wrong behavior; harmless. |

## Out of scope

- Sourcing detect.ts:44 and project.ts:80 from a shared constant (F3, culled — no current defect)
- Tightening readIntOption to strict decimal-only input (F4, culled — harmless today)
