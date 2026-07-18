## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, docs/problem-codes.md

### Approach

Every withhold of a ready task gets a name without touching the DB: the
reconciler's ready-task loop returns a bounded reason enum from each of its
~ten continue branches (paused, armed, merge-gate, in-flight, failed-key,
claim-fence vs activity-collision as DISTINCT codes, live-tab, cooldown,
missing-cwd — a louder data-bug class — and budget), and the fused
close-row okToPlan conjunction decomposes into per-arm evaluation so a
close withhold names its arm too. The reasons surface in the reconciler's
exported frame state (the machine-readable autopilot inspect surface) as a
bounded replace-merge map keyed by target, and as transition-gated stderr
lines (emit only when a target's reason CHANGES, rate-limited per
target-reason pair; per-key last-reason memory lives beside the existing
bounded reconcile state maps) — flood-then-silence is the failure mode the
gating exists to prevent. No new projection, no new RPC, no history-growing
fold. The reason enum is documented in problem-codes as a stable contract;
churny detail (ids, ages) stays out of the enum key in a detail field. The
pure decision core stays pure — reasons are computed from inputs it already
holds; emission is the producer's.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:2361-2430 — the ten continue branches; :2586-2620 — the fused close-row conjunction to decompose; :1596-1640 — the fence sub-cases
- src/autopilot-worker.ts — the frame-state export the reasons join, and the existing bounded per-cycle state maps the transition memory sits beside

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:4635+ — sweep/ordering fixture idioms
- src/board-render.ts — if a render hook is cheap, the ready-pill may carry the reason; never a new projection

### Risks

- Reason churn on an oscillating key (budget-cooldown-fence) must coalesce through the rate limit, not flood
- The close-row decomposition changes a load-bearing conjunction — behavior must be byte-identical, only observability added

### Test notes

Fixtures per branch: each withhold produces its enum code in the frame map;
an unchanged reason across cycles emits zero new lines; a transition emits
one; the decomposed close conjunction reaches the same dispatch decisions
as the fused original across the fixture matrix; the two live incidents'
shape (claim-fence on a ready task) renders the exact reason that would
have named them.

## Acceptance

- [ ] Every ready-task and close-row withhold carries a bounded enum reason in the reconciler frame state, with claim-fence and activity-collision distinct and missing-cwd classed louder
- [ ] Emission is transition-gated and rate-limited — an unchanged reason is silent, an oscillating key coalesces
- [ ] The close-row decomposition is decision-identical to the fused conjunction across the fixture matrix
- [ ] problem-codes documents the reason enum as a stable contract
- [ ] The autopilot-worker gate passes

## Done summary

## Evidence
