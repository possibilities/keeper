## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

The pause/boot reaper (`isReapCandidate`, ~src/autopilot-worker.ts:333,
wired into the `openKeys` build ~1823-1849) reaps any pane whose
`verb::id` key is in the OPEN `pending_dispatches` set, on the assumption
"open row = not-yet-bound launch ghost, safe to kill." The sibling reducer
task keeps the `approve::<id>` row open PAST SessionStart, so that row will
name a LIVE approver pane — pausing or booting in the discharge window
would then kill a working approver.

Fix it precisely by liveness, not by verb literal: when building the
pause/boot reap `openKeys` set, EXCLUDE any `(verb, id)` whose `<id>` has a
non-terminal job — reuse `isOccupyingJob(snapshot.jobs, verb, id)` (already
used 7x in this file; counts state working|stopped). A pane backed by a
live/occupying job is bound, not a launch-window ghost, so it must not be
reaped; a key with NO job (or only a terminal one) is still a genuine ghost
and stays reapable. This generalizes beyond approve, but only `approve`
rows will ever co-exist with a live job once the reducer task lands. Fix
the now-stale doc-comment (~326-331) that asserts "a present row is an
OPEN, not-yet-bound dispatch."

This task lands BEFORE the reducer task (deps wire reducer -> this), so it
is a harmless no-op until approve rows persist — eliminating any
pause-reap regression window.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:333 — `isReapCandidate` predicate + doc-comment 326-331 (the assert-the-opposite comment to correct)
- src/autopilot-worker.ts:1823-1849 — the pause/boot `openKeys` build + `reapLaunchWindowSurfaces` wiring (where to apply the liveness exclusion)
- src/autopilot-worker.ts:831 — `isOccupyingJob` (the working|stopped liveness predicate to reuse)
- src/autopilot-worker.ts:369 — `isCompletionReapCandidate` (fn-727, the SEPARATE completion-reap path; confirm the exemption doesn't disturb it)

**Optional** (reference as needed):
- src/exec-backend.ts — `reapSurfaces` (the actual pane-close mechanism)

### Risks

- Don't over-exempt: a genuine not-yet-bound approve ghost (launch crashed
  before SessionStart, no job row) SHOULD still be reapable. Gating on
  `isOccupyingJob` (live job exists) distinguishes live (don't reap) from
  ghost (reap) precisely; a blanket `verb === "approve"` skip would leak
  ghost approve panes on pause/boot.
- A terminal (ended/killed) approver's pane is dead and correctly stays
  reapable (`isOccupyingJob` is false for terminal state) — desired.

### Test notes

- Pause/boot with an approve pending row whose job is LIVE (working|stopped) -> pane NOT reaped.
- Pause/boot with an approve pending row and NO job (true ghost) -> pane still reaped.
- Pause/boot with an approve pending row whose job is TERMINAL (ended) -> still reaped (dead pane).
- work/close ghost (no job) -> still reaped (unchanged).

## Acceptance

- [ ] Pause/boot reap no longer closes a pane whose `(verb,id)` has a non-terminal job (live approver protected)
- [ ] A genuine not-yet-bound ghost (no job row) is still reaped on pause/boot
- [ ] work/close pause/boot reap behavior unchanged
- [ ] Stale doc-comment (~326-331) corrected to describe the kept-alive-approve reality
- [ ] Tests cover live-not-reaped, ghost-reaped, terminal-reaped, work/close-unchanged

## Done summary

## Evidence
