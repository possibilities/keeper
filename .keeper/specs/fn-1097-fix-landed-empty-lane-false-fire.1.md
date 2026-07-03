## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

In the lane_merged producer, the present-lane arm reports MERGED for any lane branch
that is an ancestor of local default. A freshly-cut lane with no commits sits exactly at
its fork point, making it a vacuous ancestor whenever default is at or past that commit —
so a started-but-unworked epic reads landed. The absent-lane arm already gates on
epicHasStarted; the present-lane arm needs an emptiness guard: a lane whose tip is
indistinguishable from "no work landed" must NOT read merged. Candidate directions —
pick what proves sound against both false-fire and both true-merge shapes: gate the
present-arm MERGED verdict on the epic's tasks being administratively done (mirroring the
clustered serial-group arm, which keys worker_phase); or prove non-emptiness from a
durable provision-time marker; or require the finalize path's own completion signal.
Preserve: absent-lane semantics unchanged, enumeration-inconclusive stays NOT-merged,
probe errors stay NOT-merged, and the observable stays producer-probed and change-gated.
Note the file needs grep -a (high-byte chars).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:1473-1560 — laneMergedInRepo + the per-epic loop, the clustered serial-group arm (worker_phase precedent), the started belt-and-suspenders disjunct
- test/autopilot-worker.test.ts — existing lane_merged verdict tests (extend with the empty-lane axis)

**Optional** (reference as needed):
- src/await-conditions.ts:1180-1200 — how the landed condition consumes lane_merged projection ids

### Risks

- The guard must not regress the merged-not-yet-torn-down window (lane present, truly
  merged, teardown pending) — that shape must still read landed.

## Acceptance

- [ ] A started epic with a present zero-commit lane does not appear in the lane_merged projection
- [ ] A merged lane awaiting teardown and a merged-and-torn-down lane both still report landed
- [ ] A never-started epic still never reads landed
- [ ] bun test green

## Done summary

## Evidence
