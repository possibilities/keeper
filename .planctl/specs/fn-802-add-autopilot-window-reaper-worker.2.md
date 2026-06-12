## Description

**Size:** M
**Files:** src/reaper-worker.ts, src/daemon.ts, test/reaper-worker.test.ts, test/daemon.test.ts, README.md, package.json

### Approach

New `src/reaper-worker.ts` per the worker contract (isMainThread guard,
own `openDb(dbPath,{readonly:true,prepareStmts:false,bootRetry:true})`,
`{type:"shutdown"}` handling, backend via `resolveExecBackend({noteLine})`
with `execBackend` threaded in workerData like autopilot's).

Cycle drive: copy autopilot's single-flight driveCycle
(cycleRunning/wakePending coalescing, whole cycle in try/catch so a
snapshot or readiness throw never wedges the loop), fired from BOTH
`watchLoop` data_version pulses AND a ~20s `setInterval` — the interval
is load-bearing, not telemetry: the 60s threshold elapsing writes
nothing to the DB, so time itself must wake the cycle. Both feeders
call the same single-flight entry; clear the interval on shutdown.

Each cycle:
1. `loadReconcileSnapshot(db)` — import from autopilot-worker (already
   exported; includes the merged recently-done epics read that makes
   close-row completed verdicts observable).
2. `computeReadiness(...)` with unix-SECONDS now (the autopilot
   harvest pattern; never mix ms).
3. Candidates — the FULL predicate, all clauses:
   `backend_exec_session_id === MANAGED_EXEC_SESSION` AND
   `plan_verb IN ('work','close')` with a `plan_ref` AND
   `state === 'stopped'` AND `now - updated_at > 60` AND
   non-null `backend_exec_pane_id` AND non-null `pid` (a NULL-pid row
   is degenerate bookkeeping the exit-watcher's pidless path
   terminalizes; killing on its evidence is risk without payoff) AND
   verdict `{tag:"completed"}` looked up BY VERB: work → 
   `perTask[plan_ref]`, close → `perCloseRow[plan_ref]` — never "try
   both maps" (approve rows also get perTask verdicts; the verb filter
   is what excludes them).
4. Per candidate, skip if inside the in-memory kill cooldown
   (job_id → last-attempt ts, ~10 min): a SIGHUP-absorbing process or
   already-gone window must not re-spawn tmux every cycle. In-memory
   only — a restart re-derives and re-kills once, idempotent no-op.
5. Immediately before each kill, re-run steps 1-3 fresh and require the
   SAME job to pass the FULL predicate again (fresh verdict included) —
   a resume that flipped the verdict aborts the kill.
6. `backend.killWindow(paneId)`; stamp the cooldown; one stderr audit
   line per attempt (job_id, verb, plan_ref, outcome) — the only trace
   the reaper leaves. Failures are non-fatal skips.

No DB writes, no worker→main messages beyond lifecycle: row
terminalization flows through the existing exit-watcher → Killed mint
(which matches pid+start_time and skips already-terminal rows).

Expose the predicate + candidate selection as a pure exported function
over (snapshot rows, readiness, now, cooldown map) so tests drive it at
a fixed now with no DB and a fake killWindow.

Registration ritual (all sites, same change): WorkerName union +
ALL_WORKERS (daemon.ts:1050,1070), want("reaper") spawn site (onerror +
close → fatalExit, NO onmessage minter), spawnedWorkers[] teardown
(daemon.ts:3429), ALL_WORKERS pin in test/daemon.test.ts:3202; NOT
WATCHER_WORKERS. If the new test file spawns subprocesses, add it to
package.json fast-tier --path-ignore-patterns.

README: worker count → twelve + reaper paragraph (restore-worker
paragraph as the pattern); revise the "keeper NEVER closes a window"
passage (~2279) to describe the reaper's narrow scope in present tense,
collapsing the deleted-reap history; reword the WAL aside (~118) that
uses "the reaper" generically (e.g. "background readers") so the word
unambiguously names this worker.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1307-1420 — loadReconcileSnapshot to import; :790-820 — verdict harvest + map keying; :1681-1757 — single-flight driveCycle to copy; :1559 — backend construction
- src/readiness.ts:217-238,497-516 — Verdict union + the liveness-gated completed bar
- src/exit-watcher.ts:174-182 — candidate set (stopped pids ARE watched); src/daemon.ts:2201-2294 — Killed mint
- src/wake-worker.ts:75-97 — watchLoop signature
- src/daemon.ts:1050-1091,3306-3371,3429-3478 — registration, spawn template, teardown
- test/autopilot-worker.test.ts:156-230 — makeSnapshot/makeState/makeFakeDeps pure-decision test pattern to mirror

**Optional** (reference as needed):
- src/collections.ts:124-127 — jobs live scope (stopped included, killed excluded — reaped rows fall out of the snapshot)
- src/restore-worker.ts:886-991 — worker main() skeleton
- README.md:118,2279,2355 — the three passages to revise

### Risks

- The exit-watcher coupling is the load-bearing integration: if a
  process absorbs SIGHUP, the row stays stopped with a gone window —
  the cooldown bounds the retry churn and the row is left for the
  existing backstops (accepted v1 limitation, surfaced in the audit
  line).
- Close jobs whose epic fell outside the DONE_EPICS_REAP_LIMIT=32
  merged-done window read no verdict and are never reaped — accepted
  aging bound, worth a one-line comment.
- A still-running or stale sub-agent holds the verdict off completed
  (sub-agent-stale) and the window is never reaped — inherited
  correctness-over-throughput bias, intended.
- Boot after downtime can reap a backlog burst — acceptable: each kill
  passes the full fresh predicate.

### Test notes

Pure-decision tests at fixed now: every predicate clause individually
(wrong session, approve verb, working state, under-60s, NULL pane,
NULL pid, non-completed verdict, wrong-map lookup), cooldown
suppression and expiry, close-verb perCloseRow keying, fake-killWindow
call recording, re-check abort on flipped verdict. Daemon registration
via the ALL_WORKERS pin; test:full mandatory. retryUntil for async
assertions, never Bun.sleep.

## Acceptance

- [ ] Pure candidate-selection function exported and covered clause-by-clause; approve rows and non-managed sessions provably excluded
- [ ] Kills fire only after a fresh full-predicate re-check; flipped verdicts abort
- [ ] In-memory kill cooldown bounds re-attempts; one stderr audit line per attempt
- [ ] Cycles driven by data_version pulses AND the periodic tick through one single-flight entry; interval cleared on shutdown
- [ ] Worker registered at all 4 sites incl. test pin; absent from WATCHER_WORKERS; no DB writes; no onmessage minter
- [ ] README count, reaper paragraph, "never closes a window" revision, and WAL wording landed; `bun run test:full` passes

## Done summary

## Evidence
