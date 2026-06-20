## Description

**Size:** M
**Files:** src/armed-closure.ts (new), src/autopilot-worker.ts, test/autopilot-worker.test.ts

Add the mode-gating suppression arm to the reconcile loop and the
transitive-upstream-closure helper that feeds it. readiness.ts is NOT
touched — mode is a pure post-readiness dispatch concern.

### Approach

- **Closure helper** (`src/armed-closure.ts`, pure + unit-tested): `computeEligibleEpics(armedIds: Set<string>, epicById: Map<string, Epic>): Set<string>`. Multi-source BFS seeded with every armed id, walking reversed edges via `epic.resolved_epic_deps[].resolved_epic_id` (skip `null` = dangling; skip ids absent from `epicById` = stale/unfolded). One shared `visited` set = cycle-safe by construction; the returned set is `visited` (armed nodes + all transitive upstreams). No cross-project special-casing — follow `resolved_epic_id` wherever it points.
- **Snapshot read** (`loadReconcileSnapshot`, autopilot-worker.ts:1841): read the `mode` scalar from the `autopilot_state` projection and the armed id set from the `armed_epics` collection via the existing `runQuery` path. Add both to the reconcile snapshot. Do NOT thread through `workerData`; do NOT add a `ReconcileState` cache — projection is the source of truth, read fresh each cycle.
- **Mode arm** (reconcile, pure): when `snapshot.mode === "armed"`, compute `eligible = computeEligibleEpics(armedIds, epicById)` once at the top of the cycle. In the per-row loop, `continue` (suppress) for a `work` launch when the epic is not in `eligible` — placed alongside the `state.paused` checks at :1255 (task) / :1332 (close-row), ABOVE the budget gate (:1310) so a non-eligible epic never consumes `max_concurrent_jobs` budget. **work-only:** `approve` + `close` finalizers and completion-reap stay mode-exempt (mirrors how `approve` is already budget-exempt) so disarming mid-flight finishes + reaps cleanly. In `yolo` mode the arm is a no-op.
- reconcile stays pure (reads `snapshot`, never mutates); never throws.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1154 — reconcile() structure; :1255 (task arm), :1332 (close-row arm), :1310 (budget gate) — where the mode arm slots in and the work-only exemption applies.
- src/autopilot-worker.ts:1841-1909 — `loadReconcileSnapshot` + the `runQuery`/collection read pattern to extend.
- src/types.ts:1215-1242 — `ResolvedEpicDep` (`resolved_epic_id` null=dangling, `cross_project`, per-edge `state`); Epic.resolved_epic_deps at :1197.
- src/epic-deps.ts:172 — `resolveEpicDep` (already-resolved substrate; do not re-resolve).

**Optional** (reference as needed):
- src/autopilot-worker.ts:1942-1955 — worker boot-seed (confirm mode/armed are NOT added here — projection-pull only).
- src/autopilot-worker.ts:113 — note the outdated "paused never persisted" comment; mode/armed follow a different (pull) model — don't mirror the push pattern.

### Risks

- Walking FORWARD edges computes descendants, not upstreams — must reverse (follow `resolved_epic_deps` = the deps this epic needs). Getting the direction wrong silently arms the wrong set.
- Placing the mode arm AFTER the budget gate would let non-eligible epics consume budget — must be above it.
- Caching the eligible set across cycles reintroduces staleness when the DAG changes — recompute every cycle.

### Test notes

- Closure unit tests: single armed epic with no deps → {itself}; armed B depends on unarmed A → {A,B}; cyclic deps → terminates with the cycle members in the set; dangling/absent `resolved_epic_id` → skipped, no throw; cross-project upstream → included (no special-casing).
- Reconcile tests: armed mode dispatches `work` only for the eligible set; an armed epic's unarmed upstream still gets worked; `approve`/`close` fire for a disarmed-but-in-flight epic; yolo mode unchanged; non-eligible epic doesn't decrement budget.

## Acceptance

- [ ] `computeEligibleEpics` returns armed nodes ∪ transitive upstreams via reversed-edge multi-source BFS; cycle-safe; skips dangling/absent ids; no cross-project special-casing.
- [ ] reconcile reads `mode` + armed set from the projection snapshot each cycle (no workerData, no ReconcileState cache).
- [ ] In armed mode, `work` launches are suppressed for non-eligible epics, above the budget gate; `approve`/`close`/reap are mode-exempt.
- [ ] `yolo` mode dispatch is unchanged; reconcile stays pure and never throws.

## Done summary
Added armed-mode work gating to the reconcile loop. New src/armed-closure.ts computeEligibleEpics does a multi-source reversed-edge BFS expanding the armed set to armed nodes plus transitive upstreams (cycle-safe, skips dangling/absent ids, no cross-project special-casing). loadReconcileSnapshot now pulls mode + armed set from the projection each cycle; the mode arm suppresses work for non-eligible epics above the budget gate, with approve/close/reap mode-exempt; yolo unchanged.
## Evidence
