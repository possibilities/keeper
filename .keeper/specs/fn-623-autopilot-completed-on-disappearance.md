## Overview

Autopilot's `detectJobTransitions` only migrates a dispatch from `--- current ---` to `--- completed ---` when it observes the matching embedded job's `state` flip to `"ended"`/`"killed"`. But epic-level dispatches (`close::<epic>`, `approve::<epic>`) routinely never reach that state in the snapshot stream — once an epic becomes done+approved it falls off the default subscription scope (`src/collections.ts:251-254`) before the embedded job's terminal `state` is visible. Add a fulfilled-then-disappeared rule: when `fulfilledKeys.has(key) && findSessionJob === undefined`, treat as terminal. Pure client-side rule; no schema/wire/reducer change.

## Quick commands

- `bun test test/autopilot.test.ts` — pin the new `detectJobTransitions` coverage plus the existing `predictNextDispatches` / `renderEpicCommandsFiltered` cases.
- `bun scripts/autopilot.ts` and dispatch an `approve::<epic>` against a done-epic — observe the row migrating from `--- current ---` to `--- completed ---` after the epic falls off the page.

## Acceptance

- [ ] Epic-level (`close::<epic>`, `approve::<epic>`) and task-level (`approve::<epic>.M`) dispatches migrate from `--- current ---` to `--- completed ---` after their parent epic falls off the subscription page.
- [ ] No spurious migration for never-fulfilled (queued) dispatches whose job has never appeared in the snapshot.
- [ ] Existing `state in (ended, killed)` terminal-state path continues to work for jobs whose epic remains on the page through their lifetime.
- [ ] `bun test` green; no regression in `predictNextDispatches` / `renderEpicCommandsFiltered` coverage.

## Early proof point

Task that proves the approach: `.1`. If it fails: the disappearance branch fires false positives (likely queued-but-never-fulfilled dispatches) or fails to fire when the epic drops off — both surface in the new test case before any wider integration risk.

## References

- `~/.local/state/keeper/dispatch.log` — production log with the fn-621 reproducer (close + approve epic-level dispatches stuck in `current` after fulfilled).
- `src/collections.ts:251-254` — default epics scope that causes the disappearance: `(status = 'open' OR approval != 'approved')`.
- `src/collections.ts:130` — default jobs scope (`state NOT IN ("ended", "killed")`); confirms `snap.jobs` is not a workaround.
- `src/readiness-client.ts:840-841` — `emitSnapshotIfReady`'s all-three-collections gate; the safety net that makes the disappearance signal non-spurious during reconnect.
- CLAUDE.md design stance: "design the server for the ideal architecture; do not nickle-and-dime against client churn" — confirms the fix shape (single client-side rule, no projection change).

## Docs gaps

- **`scripts/autopilot.ts:683-722`**: widen the `kind:"completed"` bullet to name both triggers (terminal-state observation AND fulfilled-then-disappeared) and cite the `emitSnapshotIfReady` dependency.
- **`scripts/autopilot.ts:877-891`**: widen the `--- completed ---` section description in `renderDispatchFrame`'s comment block to mirror the two-trigger reading.
- **`test/autopilot.test.ts`**: add the first `detectJobTransitions` coverage (no existing test for this function today).

## Best practices

- **Gate the disappearance rule on prior fulfillment.** Without `fulfilledKeys.has(key)`, every queued-but-not-yet-fulfilled dispatch would migrate to completed instantly (queued state has `findSessionJob === undefined` by definition).
- **Trust the all-three-strict `emitSnapshotIfReady` gate, don't add reconnect suppression.** `src/readiness-client.ts:840-841` only emits when all three collections have re-received their `result` frame post-reconnect; a snapshot is always internally consistent. A defensive `skipDisappearedRule` flag would add complexity for a hazard already handled upstream — document the dependency in the new docstring instead.
- **Keep the disappearance branch verb-and-form-agnostic.** Both `epic_id` and `epic_id.M` flow through the same `findSessionJob`; a `!id.includes(".")` guard would be defensive armor against a scenario that can't be constructed (task-form jobs can't disappear without the parent epic also leaving scope).
- **Ordering matters**: the new branch MUST precede the existing `if (job === undefined) continue;` — otherwise the early-return preempts it. Mark the constraint with a one-line comment so a future reorder doesn't silently break the rule.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/autopilot-completed-on-disappearance` — bundle ref from `/arthack:sketch` handoff (summary-only ride-forward; no member snippets).
