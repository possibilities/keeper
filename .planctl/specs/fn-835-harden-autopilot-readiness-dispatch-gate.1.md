## Description

**Size:** M
**Files:** src/readiness.ts, test/readiness.test.ts (and test/autopilot-worker.test.ts if the close-row test fits better there)

Two pure read-time fixes in `computeReadiness` (`src/readiness.ts`). NEITHER touches a
fold — re-fold determinism / never-throw / exactly-once-cursor are not in play. No schema bump.
VERIFY current line numbers before editing (they may have shifted).

### Approach

**(a) Never dispatch a `blocked` task.**
- Add a `runtime-blocked` member to the `BlockReason` union (~`readiness.ts:127`).
- In `evaluateTask`, add `if (task.runtime_status === "blocked") return { tag: "blocked", reason: { kind: "runtime-blocked" } }` as the **LAST predicate, immediately before the final `return { tag: "ready" }`** (~line 684). Placing it last is load-bearing: terminal-completed (1), all running verdicts (3/5/6), and dispatch-pending (10.5) still WIN — so a `worker_phase=done` task still completes/reaps despite a stale blocked flag, a live worker's mutex isn't released, and a just-launched worker isn't raced. It converts ONLY the erroneous `ready`.
- `runtime_status` defaults `"todo"` and is never null, so `=== "blocked"` is total and cannot throw. Treat ONLY literal `"blocked"` as nondispatchable (NOT `todo`/`in_progress`).
- Confirm the readiness `Task` input carries `runtime_status`; thread it through if it doesn't.
- Occupancy is correct by construction: `isLiveWorkOccupant` (~903-911) counts only `running:*` + `dispatch-pending`, so `blocked:runtime-blocked` does NOT hold the per-task/root mutex (a stuck task shouldn't).

**(c) Fix armed-mode close-row root starvation.**
- In armed mode (`eligibleEpicIds !== undefined`), the per-root mutex's pass-2a `settleCloseRow` (~`readiness.ts:1145`) and the pass-1 scoped close claim settle close rows eligibility-blind, while the launcher gates close launch on eligibility (`autopilot-worker.ts:999-1008`). The mismatch lets an ineligible close row claim a root the launcher then refuses to launch into → eligible same-root task starves.
- Fix: gate the pass-2a (and pass-1) close-row root-claim on the SAME predicate the launcher uses (`autopilot-worker.ts:1000-1007`): a close row may claim the root only if its epic is in the eligible closure OR is in-flight. Mirror the launcher exactly so the mutex never reserves a root for a closer the launcher will refuse.
- PRESERVE: a disarmed-mid-flight epic's closer must still finish → the predicate is **eligible OR in-flight**, never eligible-only. Keep yolo unchanged (the `eligibleEpicIds === undefined` path stays mode-exempt; yolo also launches closers, so no starvation there).

### Investigation targets

**Required:**
- src/readiness.ts — `BlockReason` union (~127); `evaluateTask` final `ready` return (~684); `applySingleTaskPerRootMutex` pass-2a `settleCloseRow` (~1145) + the pass-1 scoped close claim; `isLiveWorkOccupant` (~903-911); `evaluateCloseRow`.
- src/autopilot-worker.ts:999-1008 — the launcher's close-launch eligibility gate to MIRROR.
- test/readiness.test.ts and test/autopilot-worker.test.ts — existing harness + how armed/eligibleEpicIds and close rows are set up.

### Risks

- (a) placed anywhere but last could release a mutex under a live worker or mask a truer verdict — keep it last.
- (c) eligible-only (instead of eligible-OR-in-flight) would strand a disarmed-mid-flight closer; a yolo regression would re-introduce finalizer-never-starved. Cover both.

### Test notes

- (a): `runtime_status="blocked"` + `worker_phase=open` → `blocked:runtime-blocked`, not dispatched; a `worker_phase=done` blocked task still terminal-completes.
- (c): unarmed `ready` close row (fn-830 shape: open epic, all tasks done, keeper root) + armed `ready` task (fn-832.1 shape, same root) → armed task `ready`/launched, NOT `single-task-per-root`. Add BOTH armed and yolo cases (yolo must still launch the closer).
- `bun run test:full` mandatory before commit.

## Acceptance

- [ ] `computeReadiness` returns `blocked:runtime-blocked` for a `runtime_status="blocked"` task, with the gate placed AFTER terminal-completed/running/dispatch-pending (verified by a test where a done-but-blocked task still terminal-completes).
- [ ] `blocked:runtime-blocked` does not hold the mutex (occupancy unaffected).
- [ ] In armed mode, an ineligible `ready` close row no longer claims the root; the eligible same-root armed task dispatches. Disarmed-mid-flight closer still finishes; yolo still launches closers.
- [ ] New readiness tests cover both (a) and (c), armed + yolo.
- [ ] No fold touched; no schema bump. `bun run test:full` green.

## Done summary

## Evidence
