## Description

**Size:** S
**Files:** test/autopilot-worker.test.ts, src/autopilot-worker.ts, README.md, docs/exec-backend.md, CLAUDE.md

### Approach

No reap-side code change — the completion reap gates on completedRowIds, which task 1 narrows, so the reap inherits done-AND-idle for free. This task proves and documents that.

1. **Slow-tier test** in test/autopilot-worker.test.ts: a done epic whose close-scope work is live never enters completedRowIds (its verdict is running:*), so isCompletionReapCandidate stays false and reapSurfaces is not called for close::<epic_id>; once idle, the id enters completedRowIds and the reap fires. Follow the existing reap-test patterns in that file (it already imports isCompletionReapCandidate / loadReconcileSnapshot / DONE_EPICS_REAP_LIMIT).

2. **Doc updates, scoped to statements task 1 falsifies** (everything else belongs to the in-flight prose overhaul):
   - README.md ~:2139-2151 — completion-reap prose: the epic branch of "completed" now requires idle, and the "deliberately does NOT gate on is_exited" rationale collapses. Keep the still-true clause (the durable verdict is the sole authorization); replace the rationale with: liveness gating for the close-row verdict lives in src/readiness.ts.
   - README.md ~:697-698 — dep-on-epic pill description: clears only once the upstream is done AND its closer idle (in-snapshot upstreams).
   - README.md ~:307-311 — autoclose_windows description, align "completed" wording. Minor.
   - docs/exec-backend.md ~:224-226 — same is_exited rationale prune; keep the sole-authorization sentence.
   - CLAUDE.md (Autopilot, completion-reap paragraph) — replace the stale "Deliberately does NOT gate on is_exited" sentence with ONE line: liveness gating for the close-row verdict lives in src/readiness.ts, not reap-side. No new paragraph; the section is being compressed by a concurrent epic.
   - src/autopilot-worker.ts — rewrite any reap comments stating the stale status-only/is_exited rationale (present-tense invariant, no ticket ids). The cooldown ordering-chain comment (ceilingMs < PENDING_DISPATCH_TTL_MS < REDISPATCH_COOLDOWN_S) stays intact.

3. **Sanity-check the done-epics merge window**: the bounded done-epics read in loadReconcileSnapshot must now keep a done epic observable through done→idle, not just at done. No behavior change expected (the limit is generous vs closer wind-down); if the bound's comment states the old contract, update the sentence.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:501-521 — isCompletionReapCandidate (completedRowIds gate + exited live-veto)
- src/autopilot-worker.ts:2372-2410 — reapCompletionSurfaces wiring
- test/autopilot-worker.test.ts:45-57 — imports and existing reap-test fixtures to extend
- README.md:2139-2151, :697-698, :307-311 — the three stale passages
- docs/exec-backend.md:224-226 — the is_exited rationale

**Optional** (reference as needed):
- src/autopilot-worker.ts:240-267 — loadReconcileSnapshot done-epics merge + DONE_EPICS_REAP_LIMIT

### Risks

- Scope creep into the concurrent prose-overhaul epic: touch only sentences this change makes false; leave style-only cleanup alone.
- CLAUDE.md is agent-load-bearing — the replacement line must be a forward rule (what an agent should do), not history.

### Test notes

test/autopilot-worker.test.ts is slow-tier: bun run test:full is mandatory before landing (the default fast run skips this file).

## Acceptance

- [ ] Slow-tier test proves: done + live close-scope work → no reap; done + idle → reap fires for close::<epic_id>
- [ ] README, docs/exec-backend.md, and the autopilot-worker comments no longer claim status-only close completion or the is_exited rationale; the sole-authorization clause survives
- [ ] CLAUDE.md delta is at most one replaced sentence
- [ ] bun run test:full passes

## Done summary
Added slow-tier reconcile tests proving the close-row completion reap inherits done-AND-idle: a done epic with a live close-scope job stays out of completedRowIds (reap suppressed) and enters it once the closer is idle. Pruned stale status-only/is_exited close-completion rationale from README, docs/exec-backend.md, autopilot-worker comments, and added one forward CLAUDE.md line pointing close-row liveness gating at src/readiness.ts.
## Evidence
