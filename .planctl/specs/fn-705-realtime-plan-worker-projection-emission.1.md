## Description

**Size:** M
**Files:** src/plan-worker.ts, src/daemon.ts, test/plan-worker.test.ts

Give the plan-worker a fast `PRAGMA data_version` poll (mirroring the
git-worker producer archetype) so plan/epic emission no longer falls back
to the 60s heartbeat for any repo keeper already watches. The poll is a
TRIGGER, not a data source: on a version bump it runs the gated
`recheckPending()` (drains the `pending` set through `onChange` — preserves
fn-629) AND a change-gated `reconcilePlanctlDirs` re-scan (so a `.planctl`
change whose FSEvent was dropped, and was therefore never gated into
`pending`, is still recovered — the recheck-only path cannot fix that).
Because the close→approve `Commit` fold that makes a planctl file "ready"
IS a DB write, this collapses close→emit to ~50ms.

### Approach

- Add a module-level `PLAN_DB_POLL_MS` constant (match the safe floor;
  mirror git-worker's `DB_POLL_MS` value unless 25ms is justified). Init
  `lastDataVersion` ONCE at worker startup from a naked autocommit
  `PRAGMA data_version` read on the worker's existing read-only connection
  (`src/plan-worker.ts:1932`) — never reset to 0 on recheck/restart.
- Mirror the git-worker inline poll (`src/git-worker.ts:2273-2301`): on
  each tick read `data_version` OUTSIDE any open `BEGIN`; if unchanged, do
  zero work and reschedule; if changed, run `onWake` then store the new
  version. Arm the timer AFTER `seedFromDb` so the seeded change-gate
  suppresses a first-bump re-emit storm.
- Clone the single-flight `cycleRunning`/`wakePending` coalescing from
  `src/autopilot-worker.ts:1439-1486` so a bump arriving mid-scan
  coalesces into exactly one trailing re-run, never a queue.
- `onWake` body: `try { scanner.recheckPending(); reconcilePlanctlDirs(roots, scanner, "db-poll"); } catch (log+continue)` — no self-heal.
- Extend `reconcilePlanctlDirs`'s `triggerReason` union and
  `logBackstopEmit` (`:1164`) with a `"db-poll"` tag so a poll-rescued
  emit is distinguishable from a heartbeat-rescued one. Decide its log
  semantics: `db-poll` is a FAST path (expected), so it should NOT log the
  "a fast path missed it" alarm — only `heartbeat` keeps that wording.
- Shutdown: clear the poll timer in the existing teardown block BEFORE
  unsubscribe/`db.close` (`:2050-2078`), alongside the heartbeat timer, so
  a queued tick can't touch a closing DB (a leaked interval strands
  `bun test --isolate`).

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2273-2301 — the producer poll archetype to mirror; :2226-2259 shutdown ordering; :321-322 `DB_POLL_MS`
- src/autopilot-worker.ts:1439-1486 — single-flight `cycleRunning`/`wakePending` coalescing
- src/wake-worker.ts:75-97 — `watchLoop`: the naked autocommit `PRAGMA data_version` read pattern (no BEGIN, or the counter freezes)
- src/plan-worker.ts:1131-1138 (`recheckPending`), :1754-1763 (`reconcilePlanctlDirs` + `triggerReason`), :1164 (`logBackstopEmit`), :1485 (`RECONCILE_HEARTBEAT_MS`), :1920-2101 (worker main, read-only connection, heartbeat arm, shutdown teardown), :311-315 (`InboundMessage` union), :27-35 (module docstring asserting "no data_version for a foreign tree" — amend: the poll is on keeper's OWN db, the sanctioned primitive, not the foreign tree)

**Optional** (reference as needed):
- test/wake-worker.test.ts:32-65 — the watchLoop test idiom (real read-only db, commit from a separate writer connection, Bun.sleep, assert onWake)
- test/exit-watcher.test.ts:311 — single-flight assertion against a mock db
- src/daemon.ts:2064-2077 — plan-worker spawn / workerData (add `pollMs` if parameterizing the cadence for tests)

### Risks

- data_version read placement: inside an open `BEGIN` it freezes and the poll never sees a bump. Keep the sentinel read in autocommit, captured before any downstream txn.
- Self-induced poll storm: the plan-worker's own emit → reducer fold → data_version bump → poll. The change-gate (`lastEmitted`) must fully absorb the no-op re-scan; verify a quiescent board emits nothing across ticks.
- Cost on a busy DB: a full `reconcilePlanctlDirs` per bump is heavier than draining an empty pending set. Single-flight + the change-gate bound it; if profiling shows burn, run reconcile on a coarser sub-cadence than the raw recheck (note it, don't pre-optimize).

### Test notes

- Pure: extend test/plan-worker.test.ts to assert recheck+reconcile-on-trigger idempotency (unchanged path emits nothing on repeated triggers).
- Worker integration: spawn with a small `pollMs`, commit a planctl change from a separate writer connection, `Bun.sleep`, assert the snapshot emitted without a heartbeat-length wait. Assert single-flight (a burst of bumps yields one trailing re-run).

## Acceptance

- [ ] A planctl change accompanied by a DB write emits in ~50ms, asserted by a worker integration test that does NOT wait a heartbeat interval
- [ ] `PRAGMA data_version` is read in autocommit on the persistent read-only connection; `lastDataVersion` initialized once at startup, never reset to 0
- [ ] Single-flight coalescing: a mid-scan bump produces exactly one trailing re-run (asserted)
- [ ] `onWake` is try/catch-wrapped (log+continue); the poll timer is cleared in shutdown before unsubscribe/close
- [ ] `recheckPending()` stays gated (fn-629); the poll never bypasses the in-HEAD check nor writes the DB
- [ ] `db-poll` trigger tag added; a poll-driven emit does NOT log the heartbeat "a fast path missed it" alarm
- [ ] `bun test test/plan-worker.test.ts` passes; no leaked timers under `bun test --isolate`

## Done summary
Added a fast PRAGMA data_version poll to the plan-worker (PLAN_DB_POLL_MS=100, mirroring the git-worker archetype) that drives a gated recheckPending() + change-gated reconcilePlanctlDirs('db-poll') re-scan on every keeper DB write, collapsing close→emit to ~50ms; extracted makeSingleFlight coalescing, added a db-poll trigger tag that omits the heartbeat alarm wording, and cleared the poll timer in shutdown before unsubscribe/close. 9 new tests; full plan-worker suite passes clean (incl. --isolate).
## Evidence
