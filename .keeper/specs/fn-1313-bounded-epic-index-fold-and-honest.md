## Overview

Bound the reducer's last O(board) fold cost and make the event-store status
surface honest. The epic-dep index becomes a seed-once, patch-in-place
per-connection memo (byte-identical to the fresh scan — it feeds the
deterministic `resolved_epic_deps` projection); the full-replay projection
derives from the unpaced fold-work rate instead of the paced boot-catchup
wall-clock rate (measured truth: ~0.2 ms/event, ~6 min end-to-end rebuild,
vs the current ~90x-overstating extrapolation); a fold-cost bench gate pins
the growth curves. ADR 0075 (committed at plan time) records the rate
semantics, the memo contract, and the bulk-load → ANALYZE → fold rebuild
recipe.

## Quick commands

- `keeper status --json | jq .data.event_store` — after a daemon restart on the landed code: full-replay projection reflects the work rate (or null when unmeasured), catch-up projection unchanged
- `bun test ./test/refold-equivalence.test.ts` — the deterministic-replay charter suite incl. the new memo cases
- `bun run test:bench-folds` — the new opt-in fold-cost bench gate

## Acceptance

- [ ] Epic folds serve the dep index from the in-place memo with per-fold cost independent of board size; projection bytes identical warm, cold, and vs fresh scan
- [ ] `event_store.projected_full_replay_duration_ms` derives from fold-only work time (null-honest when unmeasured); catch-up projection keeps wall-clock
- [ ] A named opt-in bench gate asserts the flat epic-fold curve and pins the syncPlanLinks prefix curve; correctness gates never run it
- [ ] ADR 0075 accepted; docs/testing.md slow-tier prose distinguishes the in-process perf gate from real-process gates

## Early proof point

Task that proves the approach: ordinal 1 (the memo with byte-identity gates).
If the equivalence proof fails: revert to fresh-scan behavior (memo unseeded)
and re-scope the bench's flat assertion to a documented linear band.

## References

- docs/adr/0075-honest-replay-projections-and-rebuild-recipe.md (the epic's contract, committed at plan time)
- Measured evidence: full 1,321,785-event rebuild = 4.6 min fold (0.211 ms/event); ANALYZE 3.7s cures the fresh-DB planner cliff on the gitfold per-file seek; epic-fold cost linear in board size (~1.2 ms @ 1506 epics)
- The epic fold writes its own row before reading the index, so only in-place patching (never invalidate-and-rebuild) bounds the hot path
- NON-GOALS: syncPlanLinks classifier rewrite (cross-session sweep already fixed; live prefix exposure ≤15 ops/session); event-store checkpoint/archive (separate human-gated re-scope)

## Docs gaps

- **docs/testing.md**: revise the slow-tier framing prose (real-process count) when the in-process bench gate lands — owned by ordinal 3
- **src/protocol.ts docstrings**: state which rate feeds which projection — owned by ordinal 2

## Best practices

- **ANALYZE after bulk load** (`analysis_limit`-bounded): empty-table `sqlite_stat1` mis-plans correlated seeks; "bad stats are worse than no stats" [sqlite.org]
- **Assert benchmark slope, never absolute wall-clock**: adjacent-size ratio bands + warmup + median survive slow CI runners [criterion/Google-Benchmark methodology]
- **Memo purity**: invalidation driven only by the event-derived writes themselves; no wall-clock/env/fs reads; cache presence must not change fold output
