## Description

**Size:** M
**Files:** src/daemon.ts, src/seed-sweep.ts (new), test/daemon.test.ts

### Approach

Add new module `src/seed-sweep.ts` exporting `seedKilledSweep(db)`:

1. Query all `jobs` rows with `state IN ('working', 'stopped') AND pid IS NOT NULL`.
2. For each row: call `isPidAlive(pid)` (REUSE from `src/server-worker.ts:226` — must export).
3. If pid alive AND row has `start_time`: re-read current `start_time` from the OS (macOS: shell out to `ps -p <pid> -o lstart=` for now; can later swap to `proc_pidinfo` FFI from task 7 if available; Linux: read `/proc/<pid>/stat` field 22). Compare to row's stored value — mismatch ⇒ pid recycled ⇒ emit Killed.
4. If pid dead: emit Killed regardless of start_time presence (per Q7 backfill rule).
5. If pid alive AND row has no `start_time` (legacy): leave alone (per Q7).

Each Killed insert uses `stmts.insertEvent.run(...)` on main's writable connection (mirrors the synthetic event emitter shape at `src/daemon.ts:225-253`).

Wire into `runDaemon` between `drainToCompletion(db)` and worker spawn (`src/daemon.ts:97-138`):

```
await migrate(db);
drainToCompletion(db);
seedKilledSweep(db);
drainToCompletion(db);  // fold the just-emitted Killed events
// then spawn workers
```

### Investigation targets

**Required** (read before coding):
- `src/daemon.ts:82-89` — `drainToCompletion` signature
- `src/daemon.ts:97-138` — boot/spawn sequence
- `src/daemon.ts:225-253` — synthetic event emit shape (transcript-title) to mirror
- `src/server-worker.ts:226` — `isPidAlive` (must be exported)
- `src/plan-worker.ts:517-558` — `PlanScanner.sweep` (closest analog — read projection, diff, emit)
- `src/db.ts:533-538` — `Stmts.insertEvent`

### Risks

Boot can't proceed until sweep completes — if sweep is slow on a host with many stale jobs, server-worker can't bind UDS. Sweep is bounded by row count; each probe is cheap. Sweep MUST be deterministic across re-runs (idempotent emission — emitting Killed for an already-killed row is fine because reducer Killed-fold short-circuits on already-killed state, but better not to re-emit). Sweep MUST NOT throw — wrap each per-row probe in try/catch logged to stderr; one bad row never aborts the sweep.

### Test notes

Daemon unit test: seed `jobs` with rows: (a) alive matching pid+start_time, (b) alive recycled (pid alive but stored start_time differs), (c) dead pid with stored start_time, (d) dead pid no start_time, (e) alive pid no start_time (legacy). Run sweep + drain; assert (b),(c),(d) → killed; (a),(e) → unchanged. Idempotency: run sweep twice in a row, assert no duplicate Killed events.

## Acceptance

- [ ] `seedKilledSweep(db)` iterates non-ended jobs with pid; emits Killed per Q7 rules (dead → always; alive+stored start_time mismatch → recycled; alive+no start_time → leave alone)
- [ ] Boot sequence updated: migrate → drain → sweep → drain → spawn workers
- [ ] `isPidAlive` reused (no duplicate implementation); `isPidAlive` exported from server-worker if not already
- [ ] Sweep is idempotent; per-row throws are logged + skipped, never propagated
- [ ] Daemon unit test covers all five seed-row cases and idempotency

## Done summary
Added src/seed-sweep.ts with seedKilledSweep(db) that probes non-terminal jobs rows via isPidAlive + platform start_time re-read and emits synthetic Killed events per Q7. Wired migrate→drain→sweep→drain→spawn-workers into runDaemon; per-row probes are isolated to stderr.
## Evidence
