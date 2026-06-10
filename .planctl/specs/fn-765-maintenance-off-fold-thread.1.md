## Description

**Size:** M
**Files:** src/maintenance-worker.ts (new), src/daemon.ts, test/maintenance-worker.test.ts (new), README.md

### Approach

Create src/maintenance-worker.ts on the wake-worker template (src/wake-worker.ts —
isMainThread guard :154, workerData typed input :35-44, {type:"shutdown"} handling
:120-124, process.exit on loop end :140-149). It hosts three schedules currently
on main: (a) the backup interval — runBackupPass body (daemon.ts:3799-3855; calls
backupDb(dbPath), which already opens its OWN read-only connection and runs
VACUUM INTO + verify, src/backup.ts:306-396 — verified read-only-safe); (b) the
fn-753 boot catch-up one-shot (daemon.ts:3857-3876: isCatchUpDue +
BACKUP_CATCHUP_DELAY_MS=45s from backup.ts:132) — the worker evaluates catch-up
on start; (c) the integrity-probe interval (daemon.ts:3779-3797 —
runIntegrityProbe with liveIntegrityProbeDeps(dbPath), integrity-probe.ts:148-232;
it already uses its own short-lived RO connection, but bun:sqlite is synchronous
so today it still blocks main's event loop — that is the point of the move).
Worker→main {kind} messages relay pass outcomes (backup ok/fail+path, probe
verdict) so main keeps its existing logging/alarm behavior; the probe's
page/alarm side effects stay main-side, driven by the relayed verdict. Mirror the
never-throws + shuttingDown-guard shape of the existing timer bodies.

daemon.ts: remove the three schedules from main; spawn + supervise the worker
after migrate+boot-drain exactly like the events-ingest exemplar
(daemon.ts:3165-3219: onmessage relay, onerror + close → if(!shuttingDown)
fatalExit, shutdown postMessage + terminate). NEVER respawn in-process. Two
small guards ride along in daemon.ts: (1) wrap the stop() shutdown postMessage
loop (daemon.ts:4044-4046) in per-worker try/catch so a dead worker's
InvalidStateError cannot reject stop() and hang shutdown until launchd SIGKILL;
(2) gate countAbsentBlobs on relocated > 0 (daemon.ts:3708 — `relocated` is in
scope; mirrors the existing relocated>0 checkpoint guard at :3734). Compaction
itself STAYS on main (it writes via the writer connection — sole-writer rule).

### Investigation targets

**Required** (read before coding):
- src/wake-worker.ts — the full template; src/daemon.ts:3165-3219 — spawn/supervise exemplar
- src/daemon.ts:3691-3876 — the three schedules + compaction pass to leave behind
- src/backup.ts:132, 306-396; src/integrity-probe.ts:123-232 — the bodies (unchanged, just re-hosted)
- src/daemon.ts:4030-4046 — spawnedWorkers + the unguarded postMessage loop
- test/wake-worker.test.ts, test/backup.test.ts, test/integrity-probe.test.ts — existing seams (function-level coverage exists; add lifecycle/relay tests only)

### Risks

- Supervisor contract: worker owns no external resource beyond its connections —
  its shutdown handler closes them; main is the only terminator. If timer-hosting
  fights the contract, fall back to main-side timers dispatching pass requests to
  the worker (offload is the requirement, not timer location).
- Do not move compaction (writer op) or touch fold/ingest paths.

### Test notes

Lifecycle: spawn → backup pass message relayed → shutdown clean. stop() with a
pre-killed worker does not throw/hang (the new guard). Catch-up: stale backup dir
→ worker fires one catch-up pass on start. Existing backup/probe function tests
stay green untouched.

## Acceptance

- [ ] VACUUM INTO / integrity_check / quick_check never execute on main (grep + test)
- [ ] worker follows the contract (guard, own connections, typed messages, fatalExit wiring, supervisor-owned lifecycle)
- [ ] stop() survives a dead worker; countAbsentBlobs gated on relocated>0
- [ ] full bun test green; README backup prose updated

## Done summary

## Evidence
