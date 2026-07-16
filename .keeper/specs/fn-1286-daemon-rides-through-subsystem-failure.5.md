## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, CLAUDE.md, test/autopilot-worker.test.ts

### Approach

Implement ADR 0060's hybrid reaper as a bounded producer pass in the autopilot worker, mirroring the monitor-slot wedge producer's mint/clear-delta shape. A pure decision seam classifies each candidate: the kill arm fires ONLY on the full high-confidence conjunction — job row stopped, plan task done-stamped, recorded pid alive, harness activity showing no work evidence (sustained unknown/resource-evidence-stale from the ONE activity classifier, never a bespoke idle check) past a generous grace (mirror the existing 30min wedge horizon) — and every other stale-looking state gets the page-only arm (a new distress key in the dispatch-failure-key vocabulary, producer-owned, level-cleared on positive evidence). The kill ladder is SIGTERM → grace → SIGKILL with the (pid, OS start_time) identity re-verified immediately before EACH signal (mismatch aborts — pid reuse) plus a keeper-launched-command ownership check; a defunct kernel-zombie state is never signaled (unkillable — page instead). SIGTERM-first matters: a cleanly-exiting harness fires its stop hooks and lands the terminal lifecycle events itself; the task-4 readiness valve guarantees the wedge clears even when a SIGKILL lands no event. In-memory ladder state; a daemon reboot re-arms a fresh grace (the distress idiom re-emits at most once per still-present wedge). Coordinate with the monitor-slot backstop so one occupant never gets both a kill and a backstop page — the reaper owns the done-stamped subset. Signal-sending from the worker has precedent (the pid reprobe); the worker still never writes keeper.db — distress mints relay through main like every producer. Update CLAUDE.md's reaper-count line (prune-not-append, lint green).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1283 rewrites a doc-comment inside this exact region).*

**Required** (read before coding):
- src/autopilot-worker.ts:1291-1363 — decideMonitorSlotWedgeDistress + the mint/clear-delta contract: the pattern to mirror (and the "never a reaper" doctrine comment at ~1349 this task's ADR carves)
- src/autopilot-worker.ts:8717-8781 — the reconcile-snapshot reaper surface: provenDeadJobIds, pidLivenessByJobId, the pid reprobe (~8748-8760)
- src/session-activity.ts:111-225 — deriveHarnessActivity: the ONE activity classifier; the trigger keys on its sustained unknown/resource-evidence-stale output
- src/proc-starttime.ts + src/daemon.ts:12660-12663 — the (pid, start_time) identity-read pattern for the pre-signal re-check
- src/dispatch-failure-key.ts — add the zombie-page key here

**Optional** (reference as needed):
- src/autopilot-worker.ts:1973, 8338-8354 — the grace idiom + proven-dead slot reclaim
- src/autopilot-worker.ts:9617-9651 — producer driver wiring + the post-restart first-cycle sweep (boot-time reconcile hook)
- src/maintenance-worker.ts — the periodic sweep template if a separate cadence is warranted
- docs/adr/0060-zombie-session-hybrid-reaper.md — the recorded kill/page boundary

### Risks

- A long silent LLM inference call is the main false-positive hazard for the activity clause — the done-stamped clause is the mitigation (the assignment is finished; the generous grace is defense in depth). Never widen the kill arm past the conjunction.
- Double-action with the monitor-slot backstop on the same jobId (kill racing a page) — the decision seam must partition the candidate set explicitly.
- macOS start_time equality needs the same tolerance the existing readers use — reuse their comparison, don't hand-roll.

### Test notes

Truth-table the decision seam exhaustively: full conjunction → kill(TERM); TERM-survived past grace → kill(KILL); identity mismatch at signal time → abort + page; working-state row → none (backstop's business); pid dead → none (valve/reclaim's business); activity quiescent/active → none; defunct state → page-only. All inputs injected (synthetic clock, injected liveness/identity readers) — no real signals or processes in the fast tier. Register new suites with the fn-1281 gate manifest.

## Acceptance

- [ ] A stopped job with a done-stamped task, live pid, and no activity evidence past grace is terminated via TERM-then-KILL with identity re-verified before each signal, and the board reaches completed without human intervention.
- [ ] A pid-reuse identity mismatch aborts the kill and surfaces a page instead; no signal is ever sent to a non-keeper-launched or defunct process.
- [ ] Every stale state outside the exact conjunction is paged (or left to the existing backstop), never killed, and no occupant receives both a kill and a duplicate backstop page.
- [ ] CLAUDE.md's reaper count reflects the new producer; the CLAUDE.md lint, the touched suites, and the named gate pass.

## Done summary
Zombie-session hybrid reaper per ADR 0060 (stopped+done-stamped+alive+silent-past-grace conjunction, identity re-check, TERM-then-KILL, ambiguous pages); operator-verified 689/0 across autopilot-worker+dispatch-failure-key suites and landed via plain-git escape (duplicate-session multi_ambiguous wedge) as e1fe016f on the epic lane
## Evidence
- Commits: e1fe016f
- Tests: bun test autopilot-worker+dispatch-failure-key 689/0 (operator re-run in lane)