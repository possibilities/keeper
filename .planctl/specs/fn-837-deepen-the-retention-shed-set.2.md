## Description

**Size:** M
**Files:** src/compaction.ts (or a small cli/ entrypoint), src/backup.ts (reuse reclaimDb), README.md (runbook)

Realize the ~683 MB reclaim promptly. The steady-state 300s timer (≤10k rows/pass)
would take 5+ hours to drain the ~614k-row historical backlog, and per-batch
incremental_vacuum lags so the FILE won't shrink without a full VACUUM. This task adds a
one-shot catch-up drain + the offline VACUUM runbook. Runs AFTER .1 has landed and the
daemon has restarted with the widened predicate (keep the two landings separate so any
projection divergence is isolable). The offline VACUUM itself is operator-driven
(daemon-stopped) — like fn-836.4's reclaim.

### Approach

Add a one-shot catch-up entrypoint that drains the batched retention pass to completion
— a loop `while (retainColdPayloads(db, {maxBatches: <large>, recentRetentionMargin:
RECENT_RETENTION_MARGIN}).shed > 0) {}` (each tx still ≤500 rows; never one giant
UPDATE), or a thin CLI verb wrapping it. Then document + (operator) run the offline
reclaim using the existing src/backup.ts `reclaimDb` (VACUUM INTO + auto_vacuum=INCREMENTAL
bake + quick_check gate; caller does the atomic mv): sequence PAUSE autopilot → STOP
daemon (launchctl bootout) → drain (if not already) → reclaimDb → atomic swap + clear
stale -wal/-shm → restart (launchctl bootstrap) → keeper await server-up → verify DB
~0.6 GB, PRAGMA auto_vacuum=2, re-fold byte-identical, forensics (search-history) intact.
Keep the pre-reclaim file as rollback until verified. Set wal_autocheckpoint handling +
PASSIVE (not TRUNCATE) checkpoints per the batched-loop best practices.

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:224-313 (retainColdPayloads + its options — the catch-up loops this), :81/:98/:107 (RECENT_RETENTION_MARGIN/MAX_BATCHES/INCREMENTAL_VACUUM_PAGES)
- src/backup.ts:440-564 (reclaimDb — VACUUM INTO + auto_vacuum bake + quick_check; caller does mv), :573 (reclaimInstructions runbook to extend/mirror)
- src/daemon.ts:3273-3324 (runRetentionPass — the steady-state caller, for parity), :237 (RETENTION_INTERVAL_MS)
- the fn-836.4 offline reclaim precedent (its restore+VACUUM-INTO+swap sequence + the autopilot-pause/daemon-stop interlock)

### Risks

- VACUUM resets auto_vacuum→NONE unless re-baked — reclaimDb already bakes INCREMENTAL on the source conn + gates auto_vacuum===2; verify post-swap rather than double-implementing.
- VACUUM bumps data_version + needs the daemon stopped (autopilot is level-triggered) — pause autopilot BEFORE stopping the daemon; the offline run is operator-driven, not a worker action.
- Transient disk: VACUUM INTO needs ~1-1.5 GB free; precheck before starting.
- A giant single UPDATE would balloon WAL + starve hook INSERTs — the catch-up MUST stay batched (≤500/tx).

### Test notes

Test the catch-up drain helper (drains a seeded cold backlog to shed=0, idempotent/
resumable, each tx ≤500 rows). The offline VACUUM is operational — verify on the live
system post-run (DB size, auto_vacuum=2, re-fold). `bun run test:full` before landing the
helper code.

## Acceptance

- [ ] A one-shot catch-up drain exists that drives the widened retention to completion in batches (≤500 rows/tx, no giant UPDATE), idempotent/resumable
- [ ] Offline reclaim runbook documented (pause autopilot → stop daemon → drain → reclaimDb VACUUM INTO + swap → restart → verify); reuses reclaimDb, does not hand-roll VACUUM
- [ ] After the operator run: DB file ~0.6 GB, PRAGMA auto_vacuum=2, re-fold byte-identical, search-history intact
- [ ] `bun run test:full` green (for any helper code)

## Done summary

## Evidence
