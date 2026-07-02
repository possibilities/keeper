## Description

**Size:** M
**Files:** scripts/serve-fold-load.ts, src/db.ts (read-only reference), src/reducer.ts (read-only reference)

### Approach

Work exclusively on a copy of the live DB (cp ~/.local/state/keeper/keeper.db to the scratch dir; never open the live file read-write). First fix serve-fold-load.ts: its fold SELECT still names stale planctl_* columns (around lines 518-520) — rename to the current plan_* columns so it runs at all. Then add a replay-from-zero mode that replicates the rewinding-migration path: wipe ONLY the deterministic-replayed projection class (mirror the exact table list the rewinding migration wipes in src/db.ts — never the live-only projections, which assume producer-seeded git state and would crash or distort the numbers), reset reducer_state.last_event_id to 0, and loop drain() to completion with per-fold timing (p50/p95 keyed by event kind) plus total wall time. Run PRAGMA wal_checkpoint before timing. Emit a two-point comparison: per-event cost over the first half of the corpus vs the second half. Thresholds for task .2: per-event p95 slope >20% between halves, or total replay >10 minutes on this machine, marks a fold as a confirmed offender.

### Investigation targets

**Required** (read before coding):
- scripts/serve-fold-load.ts:518-520 — the stale column names and the existing measureFold plumbing
- src/db.ts — the rewinding-migration wipe list (which tables are deterministic-replayed vs live-only) and rewindLiveProjection
- src/reducer.ts:9140 — drain() batch loop shape

**Optional** (reference as needed):
- src/reducer.ts:8768 — applyEvent transaction shape

### Risks

Replaying live-only projections from scratch violates the documented invariant and produces garbage timing — the wipe list must mirror the migration's, not "all projections". A 1 GB copy replayed twice (half/full) may take a while; run in the background and poll.

### Test notes

The script is measurement tooling, not production surface — a smoke unit test on the half/full slope arithmetic is enough; the real verification is a clean run against the copy with numbers emitted.

## Acceptance

- [ ] serve-fold-load.ts runs green against a copy of the current live DB
- [ ] Replay-from-zero mode exists, wipes only the deterministic-replayed class, and completes with per-fold p50/p95 + total wall time
- [ ] Two-point (half vs full corpus) per-event slope emitted per fold
- [ ] Numbers recorded in Evidence with the exact re-run command

## Done summary
Fixed the stale planctl_* fold SELECT (now plan_*/worktree) so serve-fold-load runs green on a current-schema copy, and added --replay-from-zero: wipes only the deterministic-replayed class (git floor raised so the O(history) git fold self-gates), replays from id 0, emits per-fold p50/p95 by kind + a two-point half-vs-half slope. Replay of 774,612 events (batch=50) = 79-90s wall (well under the 10min budget); per-fold p50 0.08ms / p95 0.18-0.22ms / p99 0.75-0.79ms / max 15-22ms. Heavy folds are FLAT: PostToolUse (~23s total, p95 0.13-0.17ms) and PreToolUse (~22s total) both show negative half-vs-half slopes; GitSnapshot is floor-gated to 0.04ms. No confirmed O(history) scaling fold — only trivial small-n kinds (<12ms total, e.g. AutopilotCapSet/SubagentStop) flicker near +20% run-to-run for task .2 to justify as noise. Re-run: cp ~/.local/state/keeper/keeper.db /tmp/kdb-copy.db (plus -wal/-shm) && bun scripts/serve-fold-load.ts --db /tmp/kdb-copy.db --replay-from-zero
## Evidence
