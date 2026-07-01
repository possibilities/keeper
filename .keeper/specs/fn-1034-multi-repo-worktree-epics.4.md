## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/lane-merged-fold.test.ts

Make `await landed` fire only after EVERY group of a multi-repo epic has landed — worktree groups
merged to their default, serial groups' tasks done — WITHOUT a composite-PK migration, by
aggregating producer-side.

### Approach

Keep the `lane_merged` projection keyed on `epic_id` (no schema change) and give its single row
"fully landed" semantics: the producer's `computeMergedLaneEntries` emits the epic's row ONLY when
every group has landed. "Landed" per group = a worktree group's base merged to its repo's local
default (the existing per-group probe), OR a serial/disabled group's tasks all terminal-complete
(it cuts no lane and lands incrementally). Because the producer holds the full classification, it
knows the group denominator; the consumer (`computeLandedEpicIds`, pure/non-git) keeps its
existing "row → landed" logic unchanged. Per-repo lane observability continues to ride the
existing `worktree_repo_status` rows (already `repo_dir`-grained) — do NOT overload `lane_merged`
for per-repo display.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2098 — `computeMergedLaneEntries` (emits `{epic_id, repo_dir}` per ok epic; skips non-ok :2146)
- src/readiness-client.ts:478 — `computeLandedEpicIds` (any row → landed; pure/non-git; snapshot wiring :1898)
- src/await-conditions.ts:1207 — `landedState` (the await consumer)
- src/reducer.ts:3681 — `foldLaneMerged` (`ON CONFLICT(epic_id)` :3689) — confirm the epic_id PK stays

**Optional** (reference as needed):
- src/db.ts:925 — `CREATE_LANE_MERGED` (PK `epic_id`, LIVE-ONLY :1617) — unchanged
- src/collections.ts:883 — `LANE_MERGED_DESCRIPTOR` wire pk `epic_id` — unchanged
- `worktree_repo_status` fold + entry (per-repo observability home)

### Risks

- A mixed epic must count its serial group as landed-when-done, else `landed` never fires; and must
  NOT emit the epic row early on the first worktree group merging — aggregate ALL groups first.
- `computeMergedLaneEntries` runs producer-only (git probes) — keep the aggregation out of any fold.

### Test notes

Two worktree repos: assert the epic's `lane_merged` row appears only after BOTH bases are ancestors
of their defaults, not after the first. Mixed worktree+serial epic: assert `landed` waits for the
serial group's tasks done AND the worktree group merged. Single-repo epic: byte-identical to today.

## Acceptance

- [ ] The epic's `lane_merged` row (keyed `epic_id`, no schema change) is emitted only once every group has landed
- [ ] A serial/disabled group counts as landed when its tasks are terminal-complete; a worktree group when its base is an ancestor of its repo's local default
- [ ] `computeLandedEpicIds` / `await landed` consumer unchanged; `landed` never fires early on a partial multi-repo epic
- [ ] Per-repo lane observability stays in `worktree_repo_status`; single-repo behavior byte-identical
- [ ] Tests green

## Done summary
computeMergedLaneEntries now aggregates a clustered multi-repo epic: its single epic_id-keyed lane_merged row is emitted only once every group has landed (worktree groups merged to default, serial groups' tasks all done). No schema change; producer-side.
## Evidence
