## Description

**Size:** M
**Files:** src/autoclose-worker.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/restore-set.ts, src/restore-verify.ts, src/exec-backend.ts, src/exit-watcher.ts, docs/install.md, docs/problem-codes.md, test/autoclose-worker.test.ts, test/autopilot-worker.test.ts, test/restore-set.test.ts, test/restore-verify.test.ts, test/exit-watcher.test.ts

### Approach

Decouple logical completion/merge from physical resource destruction. Autoclose acts only on quiescent, completed, released/revoked ownership with exact managed-pane identity; finalize may advance logical merge once work is quiescent and done, while pane/window/lane/worktree teardown waits for an exact Resource hold to clear.

Fence cleanup by the observed resource incarnation using canonical tmux Generation, recycle-safe pid start-time, and lane/worktree identity. Move autopilot-origin `close` beside `work` under reconciler-managed recovery; durable claims decide exact resume versus revoke-and-redispatch, while manual and Adopted sessions retain generic restore. Preserve cwd-missing as detect-only and degraded probes as fail-closed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/autoclose-worker.ts:95-138,210-345,376-432` — recycle-safe decisions, eligibility rails, grace/cap behavior, and degraded probes.
- `src/reconcile-core.ts:1494-1590` — current shared occupancy gate reused by finalize/teardown.
- `src/autopilot-worker.ts:6580-6635` — finalize and recover teardown integration.
- `src/restore-set.ts:1-60` — current work-only generic-restore exclusion.
- `src/restore-verify.ts:93-165,372-480` — exact attach, refuse-live, generation attempts, and recycle-safe verification.
- `src/exec-backend.ts:499-544` — canonical tmux Generation parser/builder.
- `src/exit-watcher.ts:600-710` — StopReconciled correction versus cwd-missing detect-only belt.

**Optional** (reference as needed):
- `docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md` — accepted cleanup/restore policy.
- `docs/adr/superseded/0031-finalize-defers-on-occupying-closer.md` — superseded pane-coupled behavior and retained safety rationale.
- `test/restore-set.test.ts:1288-1372,1499-1658` — generation and recycling incident matrices.

### Risks

A logical merge must not delete the cwd of a stopped-but-reachable owner. Cleanup preconditions can conflict after restore or path reuse; conflict must defer or surface rather than force-delete. Changing close restore policy can duplicate closers if generic restore and autopilot both act during rollout.

### Test notes

Cover new activity during autoclose grace, completed quiescent owners, parked prompts, generation mismatch, recycled pid, reused lane path, restore racing queued cleanup, partial cleanup retry, degraded probes, close/work generic-restore exclusion, and unchanged manual/Adopted restore. Prove cwd-missing remains detect-only.

### Detailed phases

1. Define exact Resource-hold and cleanup-intent preconditions over existing pane/lane identity seams.
2. Split finalize merge eligibility from destructive teardown gates.
3. Make autoclose consume activity, claim disposition, and Resource holds without defining ownership by pane death.
4. Move close sessions under reconciler-managed recovery and order restore versus cleanup by exact identity.
5. Add operator-visible conflict/unknown reasons and update install/problem-code guidance.

### Alternatives

Killing every quiescent pane before finalize was rejected because cleanup should not define logical ownership. Deleting by lane path after plan completion was rejected because restored or replacement attempts may reuse the path.

### Non-functional targets

No cleanup escapes keeper-approved roots or follows an unverified resource identity. Probe failures remain non-destructive. Cleanup and restore decisions are idempotent, bounded, and safe to repeat after daemon restart.

### Rollout

Enable close’s reconciler-managed recovery only after claims and exact binding are active. Preserve legacy cleanup guards during compatibility, and keep the additive data model rollback-safe. Operator post-deploy verification exercises the resident daemon only after epic finalize.

## Acceptance

- [ ] Logical completion and merge can advance for quiescent completed work without waiting for autoclose or pane death.
- [ ] Pane, window, lane, worktree, and cwd teardown requires an exact current Resource-hold/incarnation match and never deletes a restored or replacement owner’s resources.
- [ ] Autoclose consumes activity and claim disposition, cancels on renewed activity, preserves prompt parking, and retains generation/pid safety rails.
- [ ] Autopilot-origin work and close sessions are excluded from generic restore and recover through exact claim resume or fenced redispatch; manual and Adopted restore behavior is unchanged.
- [ ] Degraded probes and cleanup-precondition conflicts fail closed with actionable diagnostics, and cwd-missing remains detect-only.
- [ ] Focused autoclose, finalize, restore, generation, and exit-watcher suites pass in process isolation.

## Done summary
Decoupled logical worktree merge from destructive pane/lane/worktree teardown: autoclose now consumes canonical Harness activity and Dispatch-claim disposition (never bare pane death), teardown requires an exact Resource-hold/incarnation match (tmux generation, recycle-safe pid start-time, lane identity), and autopilot-origin close sessions join work under reconciler-managed recovery while manual/Adopted restore is unchanged; degraded probes fail closed and cwd-missing stays detect-only.
## Evidence
