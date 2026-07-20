## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/autopilot-worker.ts, src/daemon.ts, src/reducer.ts, cli/session.ts, test/autopilot-worker.test.ts, test/reclaim.test.ts

### Approach

Per ADR 0095 decisions 1-2: extend the occupancy/reaper machinery so a
session with positive stopped evidence past a grace is reaped — TERM,
bounded grace, then KILL — blast-capped, with the conservative guards
preserved (working rows never candidates; a degraded pane probe leaves
the pass inert), for every verb the occupancy pass tracks. This must
catch the treadmill case no existing dead-classification arm reaches:
stopped, pid-alive, non-bare-shell wrapper. A stopped close session
whose epic's latest close receipt is fatal_halt at/after session start
is reap-eligible immediately with no grace. The receipt join happens at
reconcile read-time from durable close-saga state; if the projection
does not yet expose the latest close outcome, extend the plan snapshot
fold (disk-snapshot input, deterministic) — never a plan-plugin write
path into keeper.db. Align the session-terminate command-unowned
refusal text to name the daemon reap as the recovery. KILL after grace
must follow TERM even when TERM sits queued on a SIGSTOP'd pid.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:2033 — computeSlotOccupancy; the gap at :2093-2105 (neverStarted/derivedIdle) is the treadmill mechanism
- src/reconcile-core.ts:1629 — isOccupyingJob (stopped occupies while pane live)
- src/autopilot-worker.ts:1617 — decideZombieSessionReaper + :1770 executor (closest machinery; today kills only done-stamped, pages the rest)
- plugins/plan/src/verbs/close_finalize.ts:106 — FATAL_HALT receipt shape + plugins/plan/src/session_markers.ts:134 terminal marker clears
- src/daemon.ts:836-841 — load-bearing grace-constant ordering; do not disturb

**Optional** (reference as needed):
- src/reconcile-core.ts:2118-2122 — reason-string cycle-stability contract
- test/autopilot-worker.test.ts:1435-1523 — computeSlotOccupancy table; :400-476 zombie reaper table
- cli/session.ts:143 — command_unowned refusal; cli/agent.ts:140 terminateSessionProcess

### Risks

- Killing a live session mid-turn is the catastrophic failure class: the reap gate requires positive stopped state with no later working transition, and the executor re-verifies at act time, not just decision time.
- Two stopped rows sharing one verb+id key: the reap must target the correct pane.
- The zombie-session reaper pages some cases today by design; converting a page to a kill must not swallow the cases 0060 deliberately left human-visible.

### Test notes

Table-driven through the existing pure seams (slotInput /
zombieDecisionInput factories). Named gates only.

## Acceptance

- [ ] A stopped session of any tracked verb whose pane/pid stays alive is reap-decided past the grace (TERM, bounded grace, KILL; capped per sweep); working sessions are never candidates and a degraded pane probe yields an inert occupancy pass — all table-tested through the pure decision seams.
- [ ] A stopped close session whose epic's latest close receipt is fatal_halt at/after session start is reap-eligible with zero grace, while an ordinary stopped close session keeps the normal grace.
- [ ] After a reap, the freed key's next mint proceeds in a following reconcile pass with no operator retry (post-reap snapshot no longer emits the occupancy refusal for that key).
- [ ] The session-terminate command-unowned refusal names the daemon reap path as the recovery.
- [ ] The named focused gates and the typecheck are green.

## Done summary
Occupancy pass now reaps positively-stopped sessions of any tracked verb past grace via an identity-rechecked TERM -> grace -> KILL ladder, blast-capped per sweep; working rows are never candidates and a degraded pane probe leaves the pass inert. A stopped close session joins its epic's latest durable close-finalize receipt, so a fatal_halt verdict at or after session start releases the slot with zero grace. The session-terminate command-unowned refusal now names the daemon reap path as the recovery. Surface: cli/session.ts, src/autopilot-worker.ts, src/reconcile-core.ts, test/autopilot-worker.test.ts.
## Evidence
- Commits: 6ac155f03e65af3ef3d314052624f07a398720ee
- Tests: bun run typecheck (lane worktree): clean, tsc --noEmit emitted no diagnostics, bun test ./test/autopilot-worker.test.ts: 671 pass / 0 fail, 2156 expect() calls, bun test ./test/reclaim.test.ts: 8 pass / 0 fail, 33 expect() calls, Pre-existing unrelated failure inherited from the base commit: test/agent-account-routing.test.ts:798 fast-test policy calls-spawn; that file is unmodified in this lane and outside this task file surface