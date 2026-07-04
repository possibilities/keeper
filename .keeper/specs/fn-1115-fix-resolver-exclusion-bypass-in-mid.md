## Overview

The shared-checkout mid-merge self-heal has one fail-safe gap: in
`recoverSharedCheckoutMidMerge`, the SECOND `for-each-ref` that derives owning
epics for the `hasActiveResolver` check fails OPEN. On a probe timeout / spawn
failure it sets `owningEpics = []`, the resolver-exclusion guard passes
vacuously, and the pass proceeds to a flock-guarded `git merge --abort` — the
one place in the change where an inconclusive probe drives a destructive action
instead of deferring. This can abort a merge a live `resolve::<epic>` worker is
actively resolving, destroying its in-progress resolution. Bounded (flock-guarded,
re-derives next cycle) but real, and inconsistent with the defer-on-inconclusive
discipline the rest of the function holds.

## Acceptance

- [ ] An inconclusive owning-epic derivation probe defers (names the reason) rather than aborting the mid-merge.
- [ ] A test pins the keeper-owned + owning-epic `for-each-ref`-fails path and asserts no abort is issued.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Confirmed at src/autopilot-worker.ts:3319-3333 — failed owning-epic for-each-ref sets owningEpics=[], passes the resolver-exclusion guard vacuously, and proceeds to git merge --abort. |
| F2 | merged-into-F1 | .1 | F2 (untested keeper-owned + owning-epic for-each-ref-fails path) is the same root cause as F1; its pinning test lands in F1's fix task. |
| F3 | culled | — | Extra rev-parse spawns per clean readiness are bounded, cheap, and a deliberate correctness ordering — accepted-as-is, no user-noticeable impact. |

## Out of scope

- The performance advisory (F3, extra rev-parse spawns per clean readiness) — a deliberate accepted tradeoff.
- The pre-existing orphaned/squash-merged upstream detection the merge-gate deliberately does not remediate (unrelated tracked deferral).
