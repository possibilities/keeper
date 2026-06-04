## Description

**Size:** S
**Files:** src/plan-worker.ts, CLAUDE.md, README.md

With T1–T3 landed, the 60s heartbeat is no longer a latency floor — it is
a should-never-fire paranoia backstop. Reframe it as such and bring the
docs in line with the new realtime architecture.

### Approach

- Lower `RECONCILE_HEARTBEAT_MS` (`src/plan-worker.ts:1485`) from 60s to a
  small paranoia interval (~5s) so even a path no fast trigger covered is
  near-realtime. Keep the heartbeat — it is the final floor for a case
  with literally no other signal; do NOT delete it.
- Make a `"heartbeat"`-tagged `logBackstopEmit` read as a genuine ALARM
  ("a fast path missed it — investigate"), now that in normal operation it
  should never fire. Keep `"db-poll"` (T1) and any T3 reflog trigger as
  non-alarm fast-path tags.
- Update CLAUDE.md: `## Worker contract` (the plan-worker now HAS a
  `data_version` poll — remove/replace the "no data_version poll to fall
  back on" assertion; widen the kick/poll-recipient description), `## DO
  NOT` "No kernel file watchers" bullet (the poll is on keeper's OWN db,
  the sanctioned primitive — note the plan-worker's new poll; the
  `.git/logs/HEAD` watch is an EXTERNAL-tree carve-out), and the
  `## Autopilot dispatch gates` fn-629 bullet (the `recheck-pending` prose
  if T2/T3 changed the mechanism). Keep ordinals ("fourth Worker thread")
  accurate.
- Update README `## Architecture`: the fourth-worker (plan producer) block
  — document the poll interval, the poll as the realtime complement to
  FSEvents (mirror the eighth-worker/autopilot prose model), the
  `.git/logs/HEAD` tail-closer, and the heartbeat's demotion to paranoia
  backstop. Verify the worker-roster count and `@parcel/watcher`
  load-ordering paragraph stay consistent.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1485 (`RECONCILE_HEARTBEAT_MS`), :1164 (`logBackstopEmit` wording), :1754-1763 (`reconcilePlanctlDirs` triggerReason union)
- CLAUDE.md — `## Worker contract` (~326-334), `## DO NOT` no-kernel-watchers bullet (~253-276), `## Autopilot dispatch gates` fn-629 bullet (~380-399)
- README.md — fourth-worker block (~1079-1120), eighth-worker/autopilot prose model (~1654-1713), worker-roster line (~1836), `@parcel/watcher` load-ordering (~1844-1859)

### Risks

- Lowering the heartbeat raises steady-state `reconcilePlanctlDirs` frequency; the change-gate makes a quiescent reconcile a near-no-op, but confirm cost is acceptable at ~5s across all configured roots. If notable, keep the heartbeat higher and rely on the poll/reflog fast paths.
- Docs must reflect the AS-LANDED behavior of T1–T3 (hence the deps), not the planned shape — re-read the final code before editing prose.

### Test notes

- No new logic beyond the constant + log wording; covered by T1–T3 tests. Verify the heartbeat path still emits for a genuinely-abandoned uncommitted file (the one case it remains the floor for).

## Acceptance

- [ ] `RECONCILE_HEARTBEAT_MS` lowered; the heartbeat retained as the final floor (not deleted)
- [ ] A `"heartbeat"` backstop emit now reads as a loud alarm; `db-poll`/reflog fast-path tags do not
- [ ] CLAUDE.md Worker contract no longer claims the plan-worker has no data_version poll; DO-NOT and dispatch-gate prose reflect the new design; ordinals accurate
- [ ] README fourth-worker block documents the poll + reflog tail-closer + heartbeat demotion, mirroring the autopilot prose model; roster/load-ordering consistent
- [ ] Docs reflect as-landed T1–T3 behavior (re-read code before editing)

## Done summary

## Evidence
