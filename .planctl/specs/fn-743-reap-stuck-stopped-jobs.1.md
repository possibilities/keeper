## Description

**Size:** M
**Files:** src/exit-watcher.ts, src/seed-sweep.ts, src/reducer.ts (jobs fold, read-only), test/exit-watcher.test.ts

### Approach

Two parts. (1) DIAGNOSE why `stopped` rows end up with NULL pid: trace where
the jobs projection writes `state='stopped'` without a pid (src/reducer.ts
jobs fold ~:176-209) — if it's a fixable origin (e.g. a Stop event that should
carry the pid, or should fold to a watched state), fix it so new stopped rows
are watchable. (2) REAP existing/unavoidable terminal stopped rows: add a
producer-side pass (near `seedKilledSweep` / the exit-watcher) that finds
`stopped` rows whose pid is NULL or confirmed-dead (`pidAlive()` → ESRCH) and
emits a synthetic `Killed` via main. Leave alive/idle sessions untouched. Do
NOT widen the exit-watcher to close windows; do NOT probe liveness in a fold.

### Investigation targets

**Required:**
- src/exit-watcher.ts:154-157 — candidate query (`pid IS NOT NULL` exclusion = root cause)
- src/exit-watcher.ts:18-99 — job state transition table
- src/seed-sweep.ts `seedKilledSweep` — boot liveness→Killed pattern to mirror
- src/reducer.ts:176-209 — jobs fold / where `stopped` + NULL pid is written
- src/autopilot-worker.ts:955-958 `isOccupyingJob` (stopped counts as occupying)
- test/exit-watcher.test.ts:115 — the `pid IS NOT NULL` exclusion test (update it)

### Risks

- Must not reap a live idle session (idle ≠ terminal). Use `pidAlive()`; EPERM=alive.
- Producer-side only; synthetic `Killed` via main; never probe in a fold (re-fold determinism).
- Don't touch zellij windows (autoclose off).
- PID reuse on macOS: correlate with session id, don't reap on a bare pid match alone.

### Test notes

- Pin: NULL-pid stopped row → folds to terminal via the reaper. Dead-pid stopped
  row → terminal. Live-pid (this test process) stopped row → untouched.
- Update the exit-watcher candidate-set test for the new behavior.

## Acceptance

- [ ] NULL-pid / dead-pid `stopped` rows reach terminal (producer-side synthetic
  Killed); live sessions untouched; no window closed.
- [ ] NULL-pid origin diagnosed; fixed at source if cheap, else documented +
  covered by the reaper.
- [ ] Re-fold determinism preserved; `keeper jobs` no longer accumulates them.

## Done summary

## Evidence
