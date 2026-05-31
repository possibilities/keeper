## Description

**Size:** M
**Files:** src/daemon.ts, src/reducer.ts, test/daemon.test.ts, src/db.ts (maybe), CLAUDE.md, README.md

### Approach

Measurement-first. Do NOT ship a speculative fix. Phase 1: instrument the
bounce window to localize WHERE the single write lock is held long enough
to blow a concurrent hook's ~2.4s budget, and build a DETERMINISTIC
starvation reproduction. Phase 2: implement the localized fix in the
single drain path (a boot-phase parameter that gates an OS-level yield
between folds is acceptable — it is stateless and lives OUTSIDE the fold
transaction, so re-fold determinism holds; do NOT fork a second boot
path, do NOT put a sleep inside applyEvent or any project* fn). Phase 3:
prove drops→0 with the repro and on a live bounce.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts ~:579 `runDaemon` boot sequence; ~:122 `drainToCompletion`; ~:166 `withBootDrainCheckpointTuning` (the `finally` runs `wal_checkpoint(TRUNCATE)` — a candidate end-of-boot hold)
- src/reducer.ts ~:5599-5638 `drain()` per-fold loop — the post-COMMIT seam where an OS yield belongs; ~:5597 `SLOW_FOLD_LOG_MS=200`; ~:5631 the `[fold-slow]` emit (the write-lock-hold signal)
- src/seed-sweep.ts ~:188 `seedKilledSweep` (synchronous boot write; ordering vs the drains is load-bearing)
- src/server-worker.ts ~:350 `acquireLock` / bind-after-lock (acquired LATE — the structural-coexistence crux)
- test/daemon.test.ts ~:190 the `busy`-counter fixture + ~:114/148/169/199 boot-drain tests (the harness to extend with a starvation repro)
- plugin/hooks/events-writer.ts ~:407 `HOOK_BUSY_TIMEOUT_MS`, ~:730-749 the bounded-retry insert (the victim path; do not change unless raising busy_timeout as last resort)

### Risks

- **Wedge:** per-fold pacing under a large backlog (esp. from-scratch re-fold ~150k events) could add 150s+ to boot or prevent the cursor reaching head under steady inflow. MUST cap/suppress pacing on large backlogs (e.g. only pace when the backlog is small, or cap total pacing time, or pace only the first K events).
- **Determinism break:** a sleep/wall-clock read inside the fold transaction breaks re-fold. Pacing MUST be post-COMMIT in the drain loop, never in applyEvent/project*.
- **Wrong primitive:** `setImmediate`/event-loop yield does NOT release the SQLite lock to a separate process; needs a real OS sleep.
- **End-of-boot TRUNCATE:** may be the actual hold (blocks on concurrent writers). Measure start-vs-end clustering before assuming the per-fold loop is the culprit.
- **Invariant drift:** keep the single drain path (CLAUDE.md "no separate boot path"); a boot-phase parameter is OK, a forked path is not.

### Test notes

Extend test/daemon.test.ts with a deterministic starvation repro using the
`busy`-counter fixture: over a fixed N-event seeded log, a concurrent
writer attempts `BEGIN IMMEDIATE` inserts during the boot drain; assert it
hits SQLITE_BUSY with pacing OFF and ZERO with pacing ON. Add a re-fold
determinism assertion (byte-identical projections with pacing on/off — the
sleep must not change any projected row). Confirm a large-backlog case does
NOT wedge (drain still reaches head, bounded). Measure live: instrument or
grep `[fold-slow]`/`[gitfold-breakdown]` around a real bounce to confirm
where the hold was and that it's gone after.

### Detailed phases

1. **Measure + repro (keystone).** Instrument write-lock hold across the
   boot window (drain loop, seedKilledSweep, end-of-boot checkpoint,
   post-serving git burst, old↔new coexistence). Build the deterministic
   starvation test. Localize the dominant hold. If starvation can't be
   reproduced against the unpaced drain, STOP and re-localize.
2. **Fix the localized cause.** Most likely: an OS-level yield between
   boot folds via a boot-phase param to `drainToCompletion`/`drain`,
   capped so it can't wedge a large backlog. If end-of-boot clustering:
   switch `TRUNCATE`→`PASSIVE` or defer it past serving. If coexistence:
   evaluate acquiring the ownership lock before the drain (see epic
   Alternatives — larger; only if measurement points here).
3. **Prove + document.** Repro green; live bounce shows zero drops; update
   CLAUDE.md + README per the epic Docs gaps.

### Alternatives

- Structural: ownership lock before the boot drain (epic Alternatives) — evaluate post-measurement.
- Defense-in-depth: raise hook `busy_timeout` — only if daemon-side fix insufficient AND the 1.5s SessionEnd budget tolerates it.

### Non-functional targets

- No single boot write-lock hold > ~1s (well under the hook's 1200ms first-attempt timeout).
- Boot catch-up for a normal backlog (since last bounce) stays within a few seconds; from-scratch re-fold not materially slower than today (pacing suppressed there).
- Zero genuine `insert:SQLITE_BUSY` drops across observed bounces post-fix.

### Rollout

Verify on an instrumented bounce first. Deploy via a keeperd bounce;
confirm clean resume + zero new drops over several bounces. Rollback =
revert the drain-pacing change; the starvation test guards regression.

## Acceptance

- [ ] Write-lock hold during a real bounce measured + dominant hold localized
- [ ] Deterministic starvation repro in test/daemon.test.ts: SQLITE_BUSY unpaced, ZERO paced
- [ ] Pacing lives outside the fold transaction; re-fold byte-identical (determinism preserved)
- [ ] Single drain path preserved (boot-phase param, no forked path)
- [ ] Boot does not wedge on a large/from-scratch backlog (bounded catch-up, cursor reaches head)
- [ ] Post-deploy: zero genuine insert:SQLITE_BUSY drops across multiple bounces
- [ ] CLAUDE.md + README boot-sequence/invariant prose updated
- [ ] bun test green; committed to main staging only touched files

## Done summary

## Evidence
