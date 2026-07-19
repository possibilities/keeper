## Description

**Size:** M
**Files:** src/daemon.ts, cli/dispatch.ts, test/daemon.test.ts, test/reducer-projections.test.ts

### Approach

The block-escalation pipeline latches one row per (epic, task); `skipped_category` is a terminal outcome minted for TOOLING_FAILURE / unparseable categories so those never auto-escalate. The defect: the latch keys on task identity alone, so a LATER re-park under an escalatable category (e.g. AUDIT_READY, DESIGN_CONFLICT) finds the terminally-settled row and never escalates again. Behavioral contract to land: a block whose category (or reason class) differs from the one that settled the latch re-arms the row — the pipeline treats it as a fresh escalation cycle with the normal grace window, dispatching exactly one `unblock::<task>` session; the TOOLING_FAILURE suppression itself stays intact for repeat TOOLING_FAILURE blocks. Second half, same contract: the `unblock::` collision guard in the dispatch CLI refuses manual dispatch on the premise that autopilot may dispatch it — when the latch's terminal state precludes exactly that, the guard must either allow the dispatch or name the latch as the reason, never assert the falsified premise. Respect the event-sourcing invariants: the latch is producer-owned; folds stay deterministic; no new RPC surface.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1493-1520 — the latch outcome type; `skipped_category` terminal semantics
- src/daemon.ts:1599-1730 — pending-latch selection + cancellation gating + `mintAttempted(..., "skipped_category")` at :1728
- src/daemon.ts:1827-1849 — the dispatched-but-not-notified stage-3 sweep (the re-armed row must flow through all stages coherently)
- cli/dispatch.ts:166,377 — the unblock:: verb surface and the task-scoped collision guard

**Optional** (reference as needed):
- test/daemon.test.ts, test/reducer-projections.test.ts — existing block_escalations fixtures and fold coverage
- src/daemon.ts:12275 — the producer-not-projection-writer comment (keep that boundary)

### Risks

- Re-arming must not double-dispatch when a live unblock session already exists for the row — the re-arm predicate needs the same liveness guard the fresh path has.
- Category text is worker-authored; classify by parsed category class, not raw string equality, so a reworded reason in the same class does not re-arm a genuinely suppressed row.

### Test notes

Deterministic in-process tests through the latch producer seam: TOOLING_FAILURE block → latch settles skipped_category → unblock → re-block AUDIT_READY → assert one escalation after grace; repeat-TOOLING_FAILURE stays suppressed; collision-guard truth table covered at the CLI seam.

## Acceptance

- [ ] A task whose latch settled `attempted/skipped_category` and which is later re-blocked under an escalatable category produces exactly one escalation dispatch after the grace window.
- [ ] A repeat TOOLING_FAILURE (or unparseable) block on the same task remains suppressed with no escalation dispatch.
- [ ] `keeper dispatch unblock::<task>` on a latched-terminal row either proceeds without `--force` or refuses with a message naming the latch state — never the "autopilot may dispatch this" premise.
- [ ] `bun test ./test/daemon.test.ts ./test/reducer-projections.test.ts` pass, plus `bun run typecheck`.

## Done summary

## Evidence
