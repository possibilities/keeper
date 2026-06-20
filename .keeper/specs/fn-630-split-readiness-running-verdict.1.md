## Description

**Size:** S
**Files:** src/readiness.ts, scripts/board.ts, scripts/autopilot.ts, test/readiness.test.ts, test/board.test.ts

### Approach

Widen `Verdict` in `src/readiness.ts` to a four-arm union `ready |
completed | blocked | running`. Introduce `RunningReason = { kind:
"job-running" } | { kind: "sub-agent-running" } | { kind:
"planner-running" }` and drop those three kinds from `BlockReason`.
In `evaluateTask` and `evaluateCloseRow`, swap the three relevant
returns at predicates 3, 5, and 6 from `{ tag: "blocked", reason: {
kind: "*-running" } }` to `{ tag: "running", reason: { kind:
"*-running" } }`. Predicate ordering is unchanged.

Collapse `isLiveWorkOccupant` (readiness.ts:574-585) to `verdict.tag
=== "running" || (verdict.tag === "blocked" && verdict.reason.kind
=== "job-pending")` — the three motion reasons all live under the
new tag, and `job-pending` is the lone "occupies a slot but isn't
really moving" exception.

Extend `rollupEpicHeader` (readiness.ts:743-792) with a `running`
branch slotted between `ready` and `blocked` in priority: if any
task or close row is `running`, the epic header rolls up to `{ tag:
"running", reason: <first running row's reason> }`. Update
`formatPill` to emit `[running:<kind>]`; trim `formatReasonShort`'s
switch to the 10 surviving block kinds.

Renderer: in `scripts/board.ts:colorizePillsInLine`, add a
`running:*` prefix fallback that maps to the `active` (cyan)
bucket.

Autopilot: in `scripts/autopilot.ts:verdictSignature` (around
:1411-1422), add a branch for the `running` tag returning
`running:${v.reason.kind}`. In `predictNextDispatches` (around
:684-718), widen the worker-preview precondition from `cur.tag ===
"blocked" && fut?.tag === "ready"` to `(cur.tag === "blocked" ||
cur.tag === "running") && fut?.tag === "ready"` so running rows
whose simulated future is `ready` still preview their successor.
The approve branch (keyed off `fut.reason.kind === "job-pending"`)
is unaffected.

Tests: in `test/readiness.test.ts`, add a `running()` helper next
to the existing `blocked()` (line 152) and flip every `blocked({
kind: "job-running" | "sub-agent-running" | "planner-running" })`
expectation to use it. Update the three `formatPill` expectations
around lines 1320-1327 from `[blocked:*-running]` to
`[running:*-running]`. Touch sites: 220, 267, 284, 358, 382, 588,
601, 622, 736, 893, 1145, 1226, 1262, 1292, 1320-1327, 1407, 1425.
In `test/board.test.ts`, update the colorizer / orphan-row
assertions around lines 380-468 that touch `sub-agent-running`.

Verify all three test suites green before committing.

### Investigation targets

**Required** (read before coding):
- `src/readiness.ts:109-127` — current `BlockReason` and `Verdict`
  union; the type split lives here.
- `src/readiness.ts:281-407` (`evaluateTask`) and `:410-537`
  (`evaluateCloseRow`) — the three returns each that switch tag.
- `src/readiness.ts:574-585` (`isLiveWorkOccupant`) — collapse
  target.
- `src/readiness.ts:743-792` (`rollupEpicHeader`) — needs a new
  branch.
- `src/readiness.ts:857-897` (`formatPill` + `formatReasonShort`) —
  new branch, trimmed switch.
- `scripts/board.ts:414-479` — `PILL_COLORS` + `colorizePillsInLine`
  prefix-fallback table; add `running:*`.
- `scripts/autopilot.ts:1411-1422` (`verdictSignature`) — new tag
  branch.
- `scripts/autopilot.ts:684-718` — `predictNextDispatches`
  worker-preview branch; widen the `cur` check.
- `test/readiness.test.ts:152` — `blocked()` helper, the natural
  place to add a `running()` sibling.
- `test/board.test.ts:380-468` — colorizer / orphan-row sub-agent
  expectations.

## Acceptance

- [ ] `Verdict` is a four-arm union (`ready | completed | blocked |
  running`); `RunningReason` exists; `BlockReason` no longer
  contains `job-running`, `sub-agent-running`, or `planner-running`.
- [ ] `evaluateTask` and `evaluateCloseRow` return `{ tag:
  "running", reason }` for predicates 3, 5, and 6; predicate
  ordering is unchanged.
- [ ] `formatPill` emits `[running:<kind>]` for the new tag;
  `formatReasonShort`'s switch covers exactly the 10 surviving
  block kinds.
- [ ] `isLiveWorkOccupant` reads `verdict.tag === "running" ||
  (verdict.tag === "blocked" && verdict.reason.kind ===
  "job-pending")`.
- [ ] `rollupEpicHeader` propagates `{ tag: "running", reason }` at
  the epic header when any task/close row is `running` (priority
  slots between `ready` and `blocked`).
- [ ] `scripts/board.ts:colorizePillsInLine` maps `running:*` to
  the `active` cyan bucket.
- [ ] `scripts/autopilot.ts:verdictSignature` returns
  `running:${reason.kind}` for the new tag; `predictNextDispatches`
  accepts `cur.tag === "running"` alongside `cur.tag === "blocked"`
  for the worker-preview branch.
- [ ] `bun test test/readiness.test.ts test/board.test.ts
  test/autopilot.test.ts` is green; readiness expectations for the
  three motion reasons use the new `running()` helper.

## Done summary
Split the running Verdict tag out of blocked: BlockReason loses job-running/sub-agent-running/planner-running, new RunningReason union holds them, evaluator/rollup/formatPill/colorizer/autopilot updated; 136 tests across readiness/board/autopilot suites green.
## Evidence
