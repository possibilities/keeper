## Overview

`scanPlanctlDir` in `src/plan-worker.ts` only enumerates `epics/` and `tasks/`
subdirectories at daemon boot, leaving `state/tasks/*.state.json` files completely
unread. Any task that has an existing state file at startup silently projects
`runtime_status: "todo"` until that file is next touched — the board lies to
consumers for the entire window between daemon restart and next planctl write.
This fix primes `runtimeStatusCache` from the state sidecar tree before scanning
task definition files, so the first `TaskSnapshot` carries the correct value, and
adds an integration test that would have caught the regression.

## Acceptance

- [ ] After daemon restart with pre-existing `state/tasks/<id>.state.json` files,
      `runtime_status` in the projection matches the on-disk state (not `"todo"`)
      without requiring any subsequent file-system churn.
- [ ] An integration test writes a state file before constructing `PlanScanner`,
      calls `scanPlanctlDir`, and asserts the emitted `TaskSnapshot` carries the
      state-file `runtime_status`.
- [ ] Re-fold from scratch produces byte-identical `runtime_status` values.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | `scanPlanctlDir` confirmed at plan-worker.ts:1113 — loop is `["epics", "tasks"]` with no `state/tasks/` arm; daemon restart with pre-existing state files silently lies. |
| F2     | culled | —    | Type-ergonomics only; `coerceRuntimeStatus` guards ingestion; no user impact. |
| F3     | culled | —    | Auditor called it not a blocker; design stance prefers native values; no user report. |
| F4     | culled | —    | Purely cosmetic comment; no behavioral impact. |
| F5     | culled | —    | Theoretical edge cases with no reproduction; existing tests cover primary paths. |

## Out of scope

- No changes to the live `@parcel/watcher` subscribe path (it is already recursive and correct).
- No changes to `seedFromDb` or the change-gate logic.
- No other `scanPlanctlDir` callers affected — the function signature is unchanged.
