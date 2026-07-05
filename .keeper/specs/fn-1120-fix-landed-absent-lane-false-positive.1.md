## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

In `computeMergedLaneEntries` (`src/autopilot-worker.ts`), the absent-lane arm
of the `laneMergedInRepo` helper must treat a definitively-absent lane as
merged-and-torn-down only when the epic's work is actually DONE, not merely
when it has STARTED. Two coordinated edits, both inside `computeMergedLaneEntries`:

1. Make the shared done-evidence absorbing on a done epic. Where the `ok` arm
   computes `tasksDone` (currently `epic.tasks.every(t => t.worker_phase === "done")`),
   change it to also be true when `epic.status === "done"`:
   `epic.status === "done" || epic.tasks.every((t) => t.worker_phase === "done")`.
   This mirrors the canonical `isTaskTerminalCompleted` "a done epic is ABSORBING"
   rule (a force-closed / legacy-imported done epic's per-task `worker_phase` is
   never stamped, so a raw `worker_phase`-only predicate would permanently
   false-negative it). Do NOT import `isTaskTerminalCompleted` — its signature is
   heavy (`subRunningByJobId`/`epicsById`/`now` + liveness clauses) and
   autopilot-worker does not import from readiness; inline the disjunct. Keep it
   pure over the epic's own fields (re-fold-safe, constant-bounded).

2. In the absent-lane branch of `laneMergedInRepo` (the `if (!lanes.branches.has(laneBranch))`
   block, currently `return epicHasStarted;`), change the return to
   `return epicHasStarted && laneCarriesLandedWork;`. Since `tasksDone` (now
   absorbing) is passed to `laneCarriesLandedWork` at the `ok` call site and to
   the present-arm emptiness guard, the present and absent arms end up sharing one
   done-predicate. The change stays BELOW the `if (!lanes.ok) return false` guard,
   so an inconclusive enumeration is never conflated with a not-done epic.

Behavioral contract after the change: `landed` (via the `lane_merged` set) fires
for an epic iff its lane is present-and-a-real-ancestor-of-default OR
absent-and-the-epic's-work-is-terminally-done — and never while the epic is
started-but-still-running with no lane.

Then reconcile every comment that asserts the old started-only absent-arm
contract so the source matches behavior (CLAUDE.md docs-discipline; source
comments stay fn-id-free): the `computeMergedLaneEntries` function-level
doc-comment absent bullet, the `laneMergedInRepo` helper doc-comment absent bullet,
the inline absent-arm comment, and the `started`-disjunct comment (which is now
necessary-but-not-sufficient for the absent arm).

Explicitly OUT of scope (do not touch — call it out so nobody "fixes" them):
the clustered `worktree`-group call site (passes `laneCarriesLandedWork: true`
literally, by an explicit documented contract decision); `computeDeferredEpicIds`'s
absent arm (sound — it only iterates `satisfied`/done upstreams); the
`enumerateEpicLaneBranches` primitive; the squash-merge false-NEGATIVE (a known,
deliberately-unremediated stuck-state — the fix must not paper over it); and
`computeLandedEpicIds` (the worktree-mode-OFF degrade lives there, untouched).

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*
*GOTCHA: `src/autopilot-worker.ts` contains 2 real NUL bytes (~lines 2479/2501),*
*so plain `grep`/`rg` treat the WHOLE file as binary and SILENTLY return zero*
*matches. Navigate it with `grep -a`, the Read tool, or `sed -n`. The test file*
*has no NULs. The NULs are far from the edit region (~1654-1722).*

**Required** (read before coding):
- src/autopilot-worker.ts:1654-1687 — `laneMergedInRepo`; absent arm at ~1664-1669 (the return to change), present-arm guard at ~1678.
- src/autopilot-worker.ts:1707-1726 — the `ok` call site; `tasksDone` computed at ~1715, passed to `laneMergedInRepo` at ~1717. This is where the absorbing disjunct goes.
- src/autopilot-worker.ts:1556-1596 — `computeMergedLaneEntries` header doc-comment (absent bullet ~1569-1571).
- src/autopilot-worker.ts:1640-1653 and ~1703-1706 — the helper doc-comment absent bullet and the `started`-disjunct comment.
- src/readiness.ts:715-739 — `isTaskTerminalCompleted` docstring: canonical "done epic is ABSORBING" semantics the disjunct mirrors (read for the rule; do NOT import).
- test/autopilot-worker.test.ts:11374 — the test to repurpose. test/autopilot-worker.test.ts:11468 — the keep-side torn-down guard (must stay green).

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:10925 `gateGit` (`{lanes:[]}` = enumeration-ok + lane-absent), :10906 `classifyIdentity` (→ single-lane `ok`), :177 `makeTask` (defaults `worker_phase:"open"`, `runtime_status:"todo"`), :194 `makeEpic`.
- src/reducer.ts:3681-3702 and src/readiness-client.ts:484 — the consumer chain (`lane_merged` full-set REPLACE → `computeLandedEpicIds`), unchanged; read only to confirm no consumer edit is needed.

### Risks

- The done-evidence MUST be absorbing on `epic.status === "done"`. A raw
  `worker_phase === "done"`-only predicate permanently false-negatives a
  force-closed / legacy-imported done epic (its per-task latch never advances),
  breaking "a done epic always reports landed" and hanging `await landed` on it.
- Keep the `&&` change below the `if (!lanes.ok) return false` guard so an
  inconclusive enumeration stays NOT-merged, never conflated with not-done.
- The NUL-byte grep trap above will silently mislead symbol searches in the
  source file.

### Test notes

Drive the pure git-seam (`gateGit` fake runner) — never real git. Name the new
tests with THIS epic's minted fn-id (convention: the fn-prefix names the epic
owning the change, not fn-1106 where it was observed); reference fn-1106 as the
observed scenario in prose.

- Repurpose test/autopilot-worker.test.ts:11374 (currently "absent + STARTED ⇒
  MERGED-and-torn-down", fixture `runtime_status:"done"` / `worker_phase:"open"`):
  flip its assertion to `toEqual([])`, keep the "no `merge-base` ancestry probe"
  assertion (absent short-circuits before ancestry), and re-attribute its name +
  comment to the corrected "absent + started but work NOT done ⇒ NOT merged"
  contract. Its old positive claim is already covered by 11468.
- ADD the fn-1106 mid-flight regression: a multi-task `ok` epic with `.2`/`.3`
  `worker_phase:"done"` and `.1` `worker_phase:"open"` + `runtime_status:"in_progress"`,
  `gateGit({ lanes: [] })` → `toEqual([])`.
- ADD the force-closed / absorbing regression: an epic `status:"done"` with a task
  left `worker_phase:"open"` (never stamped) and an absent lane → the epic IS in
  the set (locks the absorbing disjunct against a permanent false-negative).
- ADD the completion-end lock (or reuse 11468's shape): the same serial epic with
  ALL tasks `worker_phase:"done"` and an absent lane → the epic IS in the set —
  pinning that `landed` fires AT done, not before and not never.
- Confirm still-green: 11468 (absent + all `worker_phase:"done"` ⇒ landed), 11394
  (never-started absent ⇒ not merged), and the fn-1097 present-arm cluster.

## Acceptance

- [ ] Under worktree mode, a started `ok` epic whose work is not terminally done (some task `worker_phase` open AND epic `status` not done) with a definitively-absent lane is ABSENT from the merge-landed set — `landed` holds while it runs.
- [ ] A started epic with an absent lane whose work IS terminally done is PRESENT in the merge-landed set, covering BOTH the all-tasks-`worker_phase:"done"` shape AND the force-closed/legacy shape (epic `status:"done"`, per-task `worker_phase` unstamped).
- [ ] A never-started epic with an absent lane is never in the merge-landed set.
- [ ] The present-lane arm is behaviorally unchanged: a zero-commit vacuous-ancestor lane still holds; a present ∧ real-ancestor ∧ done lane still lands.
- [ ] The clustered `worktree`-group path and `computeDeferredEpicIds` produce the same output as before this change.
- [ ] `bun test test/autopilot-worker.test.ts` is green — the repurposed test, the new regression tests, and the existing merge-landed cluster all pass.
- [ ] Source comments describing the absent-lane arm state the tasks-done requirement and match behavior; no fn-ids appear in source comments.

## Done summary
Gated the merge-landed absent-lane arm on work-done (epicHasStarted && laneCarriesLandedWork) with an absorbing status==='done' disjunct, so 'landed' no longer fires while a serial-checkout epic is mid-flight but still fires for merged-and-torn-down and force-closed epics. Repurposed the started-arm test and added mid-flight, force-closed, and completion-edge regressions.
## Evidence
