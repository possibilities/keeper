## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Bound peak WAL during the boot drain by issuing `PRAGMA wal_checkpoint(PASSIVE)` periodically
from inside the drain loop, instead of letting the WAL grow unbounded for the whole drain.
Keep `withBootDrainCheckpointTuning` (src/daemon.ts:344-355) setting `wal_autocheckpoint=0`
and keep the single final `wal_checkpoint(TRUNCATE)`. Add a size/count-gated PASSIVE inside
the `drainToCompletion`/`drain` batch loop (src/daemon.ts:154-180): trigger when the WAL
grows past a threshold (≈nLog>50k pages) or every ~10k folded events, whichever first — NOT
per-event. The checkpoint runs on the writer connection BETWEEN per-event `BEGIN IMMEDIATE`
transactions (never inside one), so it never contends its own write lock. PASSIVE returns
immediately if blocked and operates only on committed frames; mirror the existing PASSIVE
call-site pattern (try/catch, non-fatal log, read the `{busy,log,checkpointed}` result) from
the steady-state heartbeat at src/daemon.ts:3458-3469. During this task's scope (no server
worker attached yet) PASSIVE is fully effective.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:344-355 — `withBootDrainCheckpointTuning` (the autocheckpoint=0 + final TRUNCATE wrapper)
- src/daemon.ts:154-180 — `drainToCompletion` / `drain` batch loop (where the per-K PASSIVE rides)
- src/daemon.ts:3458-3469 — steady-state PASSIVE heartbeat (the call-site pattern to mirror)
- test/daemon.test.ts:147-236 — existing WAL tests (autocheckpoint disabled-in-body/restored; `wal_checkpoint(PASSIVE)` `{busy,log,checkpointed}` assertions)

**Optional** (reference as needed):
- src/daemon.ts:187 — `WAL_AUTOCHECKPOINT_PAGES`
- src/daemon.ts:1321-1424 — the boot-drain block that wraps the loop

### Risks

- PASSIVE on a per-event cadence would dominate drain time — gate on size/count, between batches only.
- The checkpoint must never run inside a fold's `BEGIN IMMEDIATE`; keep it a loop-local between transactions.
- Threshold tuning is empirical; default conservatively and log the WAL `log`/`checkpointed` so it's observable.

### Test notes

Extend test/daemon.test.ts to drive a large synthetic drain and assert the WAL page count
(`PRAGMA wal_checkpoint(PASSIVE)` `log`) stays bounded mid-loop rather than growing
monotonically, and that the final TRUNCATE still collapses it. Reuse the existing WAL-test
harness at :147-236. `bun run test:full`.

## Acceptance

- [ ] A periodic `wal_checkpoint(PASSIVE)` runs inside the boot-drain loop, gated on WAL size (≈nLog>50k pages) or ~10k events, never per-event
- [ ] `wal_autocheckpoint=0` for the drain and the final `wal_checkpoint(TRUNCATE)` are both preserved
- [ ] The checkpoint runs between per-event transactions on the writer connection, never inside a fold; the drain's cursor+projection co-advance is untouched
- [ ] A test asserts peak WAL stays bounded across a large drain and the final TRUNCATE collapses it
- [ ] `bun run test:full` green

## Done summary

## Evidence
