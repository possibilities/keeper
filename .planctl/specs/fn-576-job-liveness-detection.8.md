## Description

**Size:** M
**Files:** src/exit-watcher.ts (new), src/daemon.ts, test/exit-watcher.test.ts (new), test/integration.test.ts, README.md, CLAUDE.md, src/reducer.ts (header only), scripts/keeper-frames.ts (help text)

### Approach

Clone the `wake-worker.ts` shape (simpler than server-worker — no socket ownership) for a new `src/exit-watcher.ts` worker. Worker contract: `isMainThread` guard, own RO `openDb`, typed messages, supervisor-owned lifecycle, kqueue/pidfd fd released in own shutdown handler.

Worker internals:
1. Instantiate `ExitWatcher` from task 7.
2. Open RO connection (apply pragmas); enter data_version polling loop (`watchLoop` pattern from `src/wake-worker.ts:69-91`).
3. On data_version change: re-query `SELECT job_id, pid, start_time FROM jobs WHERE state IN ('working','stopped') AND pid IS NOT NULL`. Diff against current watch set; for new pids, call `exitWatcher.add(pid, jobIdToken)`. If `alreadyDead` returned, post `{kind:"exit", jobId, pid, startTime}` to main immediately.
4. In parallel, drive an `exitWatcher.wait()` loop on a small timeout (e.g. 1s); on exit, post `{kind:"exit", ...}` to main; on wakeup (shutdown), exit the loop cleanly.
5. Shutdown handler: `exitWatcher.close()`, `db.close()`, exit.

Main side (in `src/daemon.ts`): add a fifth `worker.onmessage` block (same shape as transcript/plan branches at ~225-253). On `{kind:"exit", jobId, pid, startTime}`: read the current jobs row, verify `start_time` matches strictly for rows with stored start_time; for legacy rows (null stored start_time), accept loosely per Q7. On match (or loose-accept): emit synthetic `Killed` via `stmts.insertEvent.run(...)` and pump wake. On strict-mismatch: skip silently (race-recovered, no Killed). `worker.onerror` → `fatalExit` (no in-process self-heal).

Spawn ordering: after seed sweep + re-drain (task 6), before any SIGTERM teardown hook. Teardown order: post `{type:"shutdown"}`, await close, terminate — same pattern as other workers.

**Docs sweep (one PR, end of epic):**

- `README.md` Architecture section: FOUR → FIVE workers; 3-state → 4-state; remove implicit "no liveness overlay" claim; update inspect SQL snippet.
- `CLAUDE.md` (and AGENTS.md symlink): event-sourcing invariants absorb `Killed` as a main-only synthetic; DO NOT carve-out clarifying that kqueue/pidfd on process descriptors is permitted (distinct from the file-watcher ban on keeper's DB); Worker contract notes exit-watcher's kqueue/pidfd resource release in its own shutdown handler.
- `src/reducer.ts` header: rewrite state-machine table to include `killed`; rewrite the "no process-liveness overlay" prose to describe `Killed` as a synthetic event that folds normally.
- `src/daemon.ts` header boot-sequence diagram: FOUR → FIVE workers, add exit-watcher to numbered list, SIGTERM step says FIVE.
- `scripts/keeper-frames.ts` `--state` help text: include killed in the default-hide list alongside ended.

### Investigation targets

**Required** (read before coding):
- `src/wake-worker.ts` (full file) — clone template
- `src/wake-worker.ts:69-91` — `watchLoop` pattern
- `src/server-worker.ts:866-888` — data_version polling shape
- `src/daemon.ts:97-138` — worker spawn block
- `src/daemon.ts:225-253` — synthetic event emit shape (transcript-title)
- `src/daemon.ts:153-156` — `onerror` → `fatalExit` pattern (one of several sites)
- `src/server-worker.ts:976-987` — `listener.stop(true)` precedent for resource release in shutdown
- `test/integration.test.ts:49-77` — real-daemon spawn + `retryUntil` pattern

**Optional**:
- `src/server-worker.ts:226` — `isPidAlive` (already exported by task 6; reuse if needed)
- README.md, CLAUDE.md, src/reducer.ts header, src/daemon.ts header, scripts/keeper-frames.ts help text — docs sweep targets

### Risks

data_version-driven re-query is the only way new pids enter the watch set. If a row appears and the pid dies before the next poll tick, the post-register liveness probe in `add()` (task 7) catches it on the very next poll — the data_version pulse rate (~50ms in wake-worker) keeps the window sub-second.

Worker `onerror` MUST escalate to `fatalExit` (no in-process self-heal). Teardown MUST release the kqueue/pidfd fd in the worker's own shutdown handler before `terminate()`. The exit-watcher's RO DB connection must run `applyPragmas` (busy_timeout) per the CLAUDE.md PRAGMA invariant.

### Test notes

- Unit: exit-watcher worker with mocked `ExitWatcher` — verify watch-set diff logic on data_version pulses; verify `alreadyDead` short-circuit; verify shutdown handler releases the fd.
- Integration: spawn a real keeperd; spawn a victim child that fires SessionStart (use the spawn-launcher pattern from `test/events-writer.test.ts`); SIGKILL the child; assert the jobs row transitions to `killed` within `retryUntil(2000, 50)`. Verify the synthetic `Killed` event lands in the events log.
- Integration: kill-then-resume — kill victim, see killed; restart victim with same `session_id`, see SessionStart fires → re-opens to stopped + refreshes pid+start_time.
- Manual: run `bun scripts/keeper-frames.ts --collection jobs` against a host with stale zombie rows; verify they disappear from the default view after the daemon restarts with this code.

## Acceptance

- [ ] `src/exit-watcher.ts` implements the worker contract (isMainThread guard, RO openDb with applyPragmas, typed messages, shutdown handler releases fd, `onerror`→fatalExit at the supervisor level)
- [ ] data_version polling drives watch-set diff; new pids → `ExitWatcher.add()`; `alreadyDead` → immediate exit message
- [ ] Main verifier emits `Killed` only on strict-match (with start_time) or loose-accept (legacy null start_time per Q7); strict-mismatch silently skipped
- [ ] Worker spawn happens after seed sweep + re-drain; teardown ordered correctly with the other four workers
- [ ] Integration test demonstrates kill → killed within 2s, then resume → re-opens
- [ ] All docs surfaces updated (README, CLAUDE.md/AGENTS.md, reducer header, daemon header, keeper-frames help text)
- [ ] Manual verification: zombie rows disappear from `keeper-frames` default view after daemon restart

## Done summary
Added src/exit-watcher.ts as the fifth Worker thread: data_version-driven diff loop keeps a kqueue/pidfd watch set in sync with candidate jobs rows, posts {kind:exit, jobId, pid, startTime} on register-time-dead or live exit; main verifies (pid, start_time) against the persisted row before inserting the synthetic Killed event. Docs sweep across README/CLAUDE.md/reducer header/keeper-frames help text; unit + integration tests cover diff filtering, FFI fd release on shutdown, kill-to-killed within 2s, and SessionStart resume re-open from killed.
## Evidence
