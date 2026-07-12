## Overview

Merge-conflict prevention re-scoped to the DOMINANT cause: base-drift. A diagnostic
over 35 historical conflicts found base-drift (a lane's base falling behind the moving
default) is 66% of conflicts vs file-overlap 29%. This epic adds a PRODUCER-side
base-freshness gate to autopilot's worktree mode: detect per-lane drift (behind-count +
merge-base age), and when a lane is quiescent and drift exceeds a tunable threshold,
refresh its base by merging the local default INTO the lane's own worktree — catching
drift conflicts early, on the isolated delta, at a quiescent point, instead of at
finalize. Gate defaults OFF (opt-in, like worktree_mode), tunable via set_autopilot_config.
All git-touching logic is producer-only (never a fold; re-fold determinism).

## Quick commands

- `bun test autopilot-worker worktree-git reconcile-core-depgraph` — probe + primitives + pure-core dep guard
- `keeper autopilot config drift_behind_threshold 15` — enable/tune the gate (OFF by default)

## Acceptance

- [ ] A producer probe computes per-(epic,repo) base-drift (behind-count + merge-base age) as plain snapshot data, worktreeMode-gated, defer-on-inconclusive, never in a fold.
- [ ] When enabled and a lane is quiescent + past threshold, a producer pass merges the local default INTO the lane's base worktree (default→base), rate-limited, reusing mergeBranchInto; refresh conflicts route to the existing worktree-merge-conflict→resolver→deconflict chain.
- [ ] Thresholds are durable autopilot_state config via set_autopilot_config (no new RPC); the gate defaults OFF.
- [ ] Merge conflicts (fan-in, finalize, refresh) record a structured conflicted-file set on dispatch_failures.
- [ ] ADR 0042 is revised in place to the base-drift design; the edit_claims/overlap-gate glossary terms are removed and base-drift/base-freshness terms added.

## Early proof point

Task `.2` (the drift probe) proves detection is cheap + deterministic producer-side. If
drift can't be measured reliably, the refresh gate has nothing to trigger on — surface
before building `.4`.

## References

- ADR 0016 (stale-aware shared-checkout catch-up), ADR 0008 (why merges avoid the shared checkout), ADR 0042 (revised in place to base-drift).
- Prior art / reuse: `computeStaleBaseLaneEntries` (autopilot-worker.ts:2863), `computeDeferredEpicIds` (:2403), `loadReconcileSnapshot` hook (:7399-7423), `mergeBranchInto`/`mergeReadiness` (worktree-git.ts:1554/:767), provision fork-source (:4118).
- Diagnostic verdict (task .1, complete): base-drift 66% (23/35) vs file-overlap 29% (10/35) across 35 keeper.db conflict incidents — the input driving this re-scope.
- Merge-queue guidance: refresh at the gate not continuously; MERGE default→base (never rebase a base dependent lanes build on); combined behind-count-OR-age trigger, tunable, defer on inconclusive git.
- NOTE (tooling): task titles `.2`-`.5`/`.7` retain their pre-rescope edit-claims wording — the plan tooling cannot rename tasks; each task's SPEC is the authoritative base-drift work.

## Docs gaps

- **docs/adr/0042**: revise in place toward base-freshness/rebase-cadence; keep decision #4 (conflicted-file capture) + #5 (measurement); do NOT move to superseded/ (never landed).
- **CONTEXT.md**: remove Edit claim / Overlap gate; add base-drift / base-freshness / lane-base terms (relate to Merge-gate).
- **CLAUDE.md**: one-line producer-only base-freshness guardrail on the merge-gate line.
- **docs/problem-codes.md**: add a row only if a new distress code is minted (else reuse worktree-merge-conflict).
