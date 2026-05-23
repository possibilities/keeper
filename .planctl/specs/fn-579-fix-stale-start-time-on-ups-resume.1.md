## Description

Fixes finding `f-001` (`stale-start-time-after-ups-resume`) from the
`fn-576-job-liveness-detection` inline audit.

**Bug chain (reproduced from evidence, verified during /plan:close):**

1. `SessionStart` `(pid=100, start_time=X)` →
   `(state=stopped, pid=100, start_time=X)`.
2. Real `Killed` event for `(pid=100, start_time=X)` folds →
   `(state=killed, pid=100, start_time=X)`.
3. `UserPromptSubmit` arrives with new `pid=200` and no `start_time`
   (UPS events never carry one). `reducer.ts:594-600` runs
   `UPDATE jobs SET state='working', pid=COALESCE(?, pid), ...`
   and DOES NOT touch `start_time`. Row becomes
   `(state=working, pid=200, start_time=X)`. The poisoned
   intermediate state is codified by `test/reducer.test.ts:492-510`.
4. Daemon restart. `seedKilledSweep` at `seed-sweep.ts:203-241`
   picks up the row. `isPidAlive(200) === true`,
   `readOsStartTime(200) === Y` (the real live process), and
   `seed-sweep.ts:226` sees `Y !== X` (stale) — emits a synthetic
   `Killed` carrying the row's STORED `start_time=X` (line 234).
5. The reducer's `Killed` fold at `reducer.ts:631-672` sees
   `row.pid=200 === payload.pid=200` (pidMatches) AND
   `row.start_time=X === payload.start_time=X` (startMatches,
   strict branch) — folds to `killed`.
6. The default jobs filter introduced by fn-576 task `.5` hides
   `killed` rows, so the live resumed session silently disappears
   from `keeper-frames`.

**Fix:**

In `reducer.ts` `UserPromptSubmit` branch (around line 594-600),
clear `start_time` to `NULL` whenever the event's pid is provided
AND differs from the persisted pid. A pid change is the signal that
the persisted `start_time` no longer describes the live process; a
NULL `start_time` then activates the legacy-loose-match branch in
both producers (`seed-sweep.ts:214-217`: "pid alive + no stored
start_time → cannot prove recycle. Leave alone.") and the reducer
(`reducer.ts:663`: `row.start_time == null` accepts the loose
pid-only match). The next `SessionStart` resume will refresh
`start_time` to the new live value as usual. When the event omits
`pid` (legacy hook), behavior is unchanged.

Sketch (final SQL may use a single CASE expression):

    UPDATE jobs SET state = 'working',
                    pid = COALESCE(?, pid),
                    start_time = CASE
                      WHEN ? IS NOT NULL AND ? != pid THEN NULL
                      ELSE start_time
                    END,
                    last_event_id = ?, updated_at = ?
      WHERE job_id = ?

Update the comment block at `reducer.ts:580-593` so the next reader
understands WHY start_time is cleared on pid change (the
recycle-safe identity invariant — `(pid, start_time)` must always
describe the same live process).

**Test updates:**

- Update `test/reducer.test.ts:492-510` to assert
  `expect(job?.start_time).toBe(null)` after the killed→UPS-new-pid
  sequence (replacing the current `toBe("macos:t1")` assertion).
- Add a NEW cross-boot integration test that exercises the full
  chain: SessionStart → Killed → UPS(new pid) → simulate daemon
  restart (re-run seed sweep against the same DB) → assert no
  synthetic Killed event was inserted and the row stays
  `state=working`. The integration suite already has a SIGKILL→
  resume scenario to model from.

**Invariants this fix MUST preserve:**

- Producer-only liveness probing — the reducer still NEVER calls
  `kill(0)` / reads `/proc` / probes start_time inside the fold.
- Determinism on re-fold — the new CASE expression is a pure
  function of the event payload (`event.pid`) and the persisted
  row (`pid` column). Re-folding from a wiped projection
  reproduces the same outcome.
- Hook stays exit-0 — no change to the hook; this is a reducer-side
  SQL change only.

## Acceptance

- [ ] `UserPromptSubmit` fold sets `start_time = NULL` when
      `event.pid != null AND event.pid !== row.pid`; leaves
      `start_time` untouched when pid matches or event pid is missing.
- [ ] Comment at `reducer.ts:580-593` updated to explain WHY the
      clear happens (recycle-safe identity invariant).
- [ ] `test/reducer.test.ts:492-510` updated to assert
      `start_time === null` after the killed→UPS-with-new-pid sequence.
- [ ] New cross-boot test (in `test/reducer.test.ts` or
      `test/integration.test.ts`) reproduces the full
      kill → UPS-resume-with-new-pid → seed-sweep-rerun chain and
      asserts the resumed row remains `state=working` and no synthetic
      `Killed` event was emitted.
- [ ] `bun test` green.
- [ ] No new in-fold liveness probe; no change to terminal-state
      guards; no schema change.

## Done summary

## Evidence
