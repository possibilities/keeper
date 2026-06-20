## Overview

Autopilot double-dispatches workers when a `claude` worker's cold boot
(~60 plugin dirs, 24-33s to SessionStart) outlasts `confirmRunning`'s 18s
confirm ceiling. The false timeout clears the in-flight dedup guard and
mints a spurious `DispatchFailed`, and a reconcile firing before the
worker's SessionStart folds into `jobs` finds all three dedup guards
missing — so it launches a SECOND worker for the same `(verb, id)`.
Verified on prod 2026-06-01 (fn-630 approve + fn-631 work, both "confirm
timeout after 18000ms", two SessionStarts each landing AFTER the ceiling).

The fix closes the blind window between "launch succeeded" and "SessionStart
folded" by probing zellij for the worker's uniquely-named tab. Every worker
is launched into a zellij tab named exactly its `verb::id` dedup key
(`buildZellijNewTabArgs --name <key>`), so a name-exact tab probe is a
producer-side liveness signal available the moment the launch materializes —
long before SessionStart, and with no `claude` PID (zellij detaches the
worker into the zellij server's process tree, so no PID is ever available
pre-SessionStart). End state: a successful launch durably claims the slot
until SessionStart hands off to `isOccupyingJob`; a slow boot never reopens
the window; a daemon restart re-derives occupation from the live probe; no
schema change.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — reconcile / confirm / dedup contract
- `bun test test/exec-backend.test.ts` — the new name-exact tab probe parse
- Manual: pause autopilot, leave one ready task, play once, then
  `zellij --session <s> action query-tab-names` shows exactly one `verb::id`
  tab AND `SELECT count(*) FROM jobs WHERE plan_ref=<id> AND plan_verb=<verb>` is 1

## Acceptance

- [ ] A successful launch claims the `(verb, id)` slot until SessionStart binds a `jobs` row OR the zellij tab named `verb::id` disappears
- [ ] A confirm timeout while the tab exists does NOT mint `DispatchFailed` and does NOT free the slot
- [ ] A second reconcile in the launch->SessionStart window does NOT re-dispatch
- [ ] `DispatchFailed` is minted only on launch `{ok:false}` OR ceiling-elapsed-with-no-tab-and-no-jobs-row
- [ ] `reconcile()` stays pure — the zellij probe runs once per cycle at snapshot load; live tab-names pass in as snapshot data
- [ ] No `SCHEMA_VERSION` bump, no reducer change, no keeper-py change
- [ ] fn-644 one-at-a-time stagger, the three dedup guards, and watermark exclusion still pass

## Early proof point

Task that proves the approach: `<epic_id>.1` — the autopilot-worker test
suite green with the timeout-but-alive case asserting no `DispatchFailed`
and no re-dispatch. If it fails: the tab-name probe may not be queryable
before SessionStart in practice — fall back to option (a), a generous
confirm-ceiling bump (60-90s) as the sole give-up path, accepting the
residual slow-boot boundary.

## References

- Incident forensics (prod keeper.db, 2026-06-01 ~17:51): two `DispatchFailed` "confirm timeout after 18000ms" rows; SessionStarts at +24s / +33s; 9s apart = 18s between launches minus boot variance. Single daemon, not a lock/two-daemon bug.
- `src/autopilot-worker.ts` — `confirmRunning` :683-752, `runReconcileCycle` :795-835 (`finally{inFlight.delete}` :832), `reconcile` :509-666 (guards :566/:569/:572), `isOccupyingJob` :464-479, `ConfirmOutcome` :378, `DEFAULT_CEILING_MS` :393
- `src/exec-backend.ts` — `buildZellijNewTabArgs --name <key>` :279-312, `resolveTabForPane` list-panes parse to mirror :693-748, name-exact `query-tab-names` recycle-safety :92, `closeByName` resolves pane via `list-panes -a -j` tab_name
- `fn-673` (reverse-dep, advisory) — focuspane exec backend op extends `ExecBackend` in the same layer; adding a probe method here may force a small rebase. Coordinate, do not block.
- `fn-670` (overlap, advisory only) — touches `reducer.ts`/`jobs` projection; this fix only READS `jobs` (unchanged) + adds a zellij probe, so files are disjoint. Not wired as a blocking dep.
- `fn-672` (overlap, moot) — KNOWN_EVENT_COLUMNS lockstep applies only on a `SCHEMA_VERSION` bump; option (c) bumps no schema, so the overlap evaporates.
