## Description

**Size:** S
**Files:** src/worker-cell.ts, src/reconcile-core.ts, src/autopilot-worker.ts, cli/dispatch.ts, test/worker-cell.test.ts, docs/problem-codes.md

### Approach

Extend the closed WorkerCellResult union with a no-route reject carrying the capability
name: resolveWorkerCell probes the matrix for WRAPPED cells only (driver wrapped and an
empty provider order = no-route); native cells never touch the probe and behave
byte-identically, matrix present or absent. The compile break at every assertNever caller
is the parity net — map the new kind in the autopilot producer (a sticky DispatchFailed
naming the matrix file, change-gated like existing rejects, cleared by retry_dispatch
after the config fix) and in manual dispatch (non-zero exit with the code). Daemon
posture for a malformed matrix at probe time: degrade to the same visible sticky naming
the file — never fatalExit; fail-loud parsing stays a CLI-only posture. Add the
problem-codes row for the dispatch-family code, distinct from the run-time no_route the
providers resolve verb emits.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worker-cell.ts:157-214 — the closed union, the probe pipeline, and the parity comment
- test/worker-cell.test.ts:243 — the closed-union exhaustiveness test to extend
- src/reconcile-core.ts:1740-1772 — the producer compose site where cells resolve

**Optional** (reference as needed):
- src/autopilot-worker.ts:2996 — producer-side cell re-validation
- cli/dispatch.ts:721 — the manual dispatch resolve call
- docs/problem-codes.md — the family table the new row joins

### Risks

- The probe adds a config read to a dispatch-path seam — keep it producer-side only and
  bounded, mirroring the existing filesystem cell probes; no fold may ever read it.

### Test notes

Union exhaustiveness, wrapped-cell-no-providers → no-route, native-cell bypass, malformed
matrix → degrade-not-throw, sticky mint + retry_dispatch clear via existing fixtures.

## Acceptance

- [ ] A wrapped-cell task with zero configured providers mints a visible sticky dispatch
      failure naming the matrix file, and retry_dispatch re-arms it after the config is fixed.
- [ ] Native cells never consult the matrix probe and dispatch byte-identically with or
      without a matrix file; a malformed matrix degrades to the sticky, never a daemon exit.
- [ ] The closed-union exhaustiveness test covers the new kind and manual dispatch
      surfaces the same reject with a documented code.

## Done summary
Added a no-route WorkerCellResult reject: resolveWorkerCell probes the host matrix down the compose-reject arm only (native cells bypass it, malformed matrix degrades to a visible sticky), the autopilot producer mints a retry_dispatch-clearable sticky naming matrix.yaml, and manual dispatch exits non-zero with the documented worker-cell-no-route code.
## Evidence
