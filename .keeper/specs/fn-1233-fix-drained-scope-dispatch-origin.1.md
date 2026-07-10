## Description

Fixes F1 (Critical), with merged test-coverage findings F2 and F3.

Root cause (verified in the epic worktree, HEAD d5e7a3a3): the pure
`drainedState` predicate (src/await-conditions.ts:1413) correctly filters
running jobs by `isKeeperDispatched(job.dispatchOrigin)`, but the CLI builds
its `runningJobs` from `snap.jobs.values()` reading `job.dispatch_origin ?? null`
(cli/await.ts:2022-2026). `snap.jobs` is the wire subscribe
`makeState("jobs", …, collection:"jobs")` (src/readiness-client.ts:1928), and
`JOBS_DESCRIPTOR.columns` (src/collections.ts:99-190) does NOT include
`dispatch_origin`. So `job.dispatch_origin` is `undefined` at runtime → `null`
→ `isKeeperDispatched(null)` is false for every job. The `Job` TYPE
(src/types.ts:596) declares the field, so tsc and the `jobRow` fixture
(test/await.test.ts:291, which injects `dispatch_origin` directly) never catch
the type-vs-runtime projection gap.

Fix direction is a genuine design choice — pick one and justify it:
- Add `"dispatch_origin"` to `JOBS_DESCRIPTOR.columns` (simplest, but widens
  the shared jobs wire shape for every subscriber and conflicts with the
  explicit "deliberately omits" decision documented in
  src/autoclose-worker.ts:116-123, where the autoclose pulse reads
  `dispatch_origin` via a direct SELECT rather than the descriptor path); OR
- Source the drained running-job set through a scope-exempt query that includes
  `dispatch_origin` (mirrors the autoclose direct-SELECT precedent, narrower
  blast radius on the wire).

Files: src/collections.ts, cli/await.ts, src/readiness-client.ts (whichever the
chosen fix touches), test/await.test.ts.

F2 (merged): re-add integration coverage that composes the jobs frame through
the ACTUAL descriptor/wire projection (or asserts `dispatch_origin` is served on
the drained path), so a future regression of the strip is caught — the current
green suite passes only because `jobRow` injects the column.

F3 (merged): in the same real-projection integration test, assert
`deps.ownSessionId` flows through the CLI drained projection (cli/await.ts:2045)
to self-exclude the caller's own dispatched job — self-exclusion is only
reachable once dispatch discrimination is live.

Value-space is otherwise correct: `dispatch_origin` is only ever
`autopilot`/`escalation`/`null` (src/reducer.ts), which `isKeeperDispatched`
covers exactly; the pure predicate needs no change.

## Acceptance

- [ ] The drained running-job set reads a real `dispatch_origin` sourced through
      the server projection; `keeper await drained --scope inflight` holds while
      a working autopilot/escalation job exists and clears when it ends.
- [ ] `keeper await drained` (plan scope) holds while a live escalation session
      (dispatch_origin='escalation', plan_verb=NULL) exists despite all plan/
      close rows completed.
- [ ] An integration test drives the REAL jobs-wire projection for
      `dispatch_origin` (not the injected `jobRow` field) and asserts caller
      self-exclusion via `ownSessionId` through the CLI drained projection.

## Done summary

## Evidence
