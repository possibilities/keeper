## Overview

Autopilot readiness currently blocks an epic's tasks while its planner/refiner
session is still working — the `planner-running` gate (predicate 3 in
`computeReadiness`). That same verdict stamps a `running:planner-running` pill
onto the epic header, EVERY task row, and the close-row of `keeper board`, so
one working planner shows the pill many times over. This epic removes the gate
and its now-dead helper logic so an epic reads `ready` as soon as its plan is
validated — even while the planner/refiner is still running — and the duplicate
board pills disappear with zero board-render change. The `epic-not-validated`
gate (predicate 2, ranked above the removed one) remains the guard that keeps a
mid-refine, unvalidated epic non-dispatchable.

This is a TIGHT readiness-only removal. The `job_links` projection, the reducer
fold that keeps it fresh, the `epics.job_links` schema column, and the board's
`[creator]/[refiner] [working]` job-link line all stay untouched — there is NO
schema migration and NO SCHEMA_VERSION bump.

## Quick commands

- `bun run test:full` — full suite incl. readiness/autopilot tiers (mandatory before landing)
- `grep -rn "planner-running" src/ cli/` — must return zero hits after the change
- the repo typecheck (`bun run tsc` / `bunx tsc --noEmit`) — catches test fixtures still typed against the dropped union member (there is NO exhaustiveness error on removal)

## Acceptance

- [ ] No `running:planner-running` verdict is ever produced; the board pills for it are gone on the epic header, task rows, and close-row.
- [ ] The readiness gate + its two helpers + the `RunningReason` union member + the icon-theme entry are removed; `isRootOccupant` collapses to `isLiveWorkOccupant` and stays exported + green for its `autopilot-worker` callers.
- [ ] The `job_links` projection, reducer fold, and `cli/board.ts` job-link line are unchanged; no schema migration.
- [ ] `bun run test:full` green; `grep "planner-running"` clean over src/ + cli/; typecheck clean.

## Early proof point

Task that proves the approach: `.1` — the whole change is one cohesive task.
If it fails: the likely failure is the fn-725 cap-test rework or a missed
`planner-running` string the typecheck did not flag; `grep` + `test:full`
localize it.

## References

- `src/readiness.ts` — `computeReadiness` predicate pipeline. Predicate 2 (`epic-not-validated`, readiness.ts:540/796) is the RETAINED guard; predicate 3 (`planner-running`) is removed.
- fn-663 (per-root mutex planner-exemption) and fn-725 (per-root cap planner-exemption) — the semantics being retired; their tests are reworked or deleted, not preserved.
- `src/autopilot-worker.ts:51,880,885` — the `isRootOccupant` callers that must stay green after it collapses to a passthrough.

## Docs gaps

- **README.md (~2428-2429, ~754)**: scrub mutex prose naming the planner exemption from the per-root mutex (fn-663/fn-725) and confirm the `PILL_COLORS` `running:*` prose names no specific `planner-running` pill — forward-facing register, no change-history narration.
- **CLAUDE.md `## Autopilot`**: confirm no planner-running-specific gate enumeration lingers (the general `computeReadiness` reference is fine, leave it).

## Best practices

- **Grep, don't trust the compiler:** removing this discriminated-union member raises NO TypeScript exhaustiveness error — every consumer interpolates `reason.kind` as a string (`formatPill`, `verdictPhrase`). Audit via `grep "planner-running"` + typecheck, not the compiler. [practice-scout]
- **The validation gate is the load-bearing guard:** `epic-not-validated` (predicate 2) now solely covers the mid-refine non-dispatch window; a forward-facing comment there documents that contract so a future reader doesn't re-add serialization. [gap-analyst]
