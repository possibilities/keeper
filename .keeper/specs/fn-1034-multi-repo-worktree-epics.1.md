## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/db.ts, src/reducer.ts, keeper/api.py, test/autopilot-worker.test.ts, test/worktree-plan.test.ts

The keystone. Make the PRODUCER partition an epic's tasks by resolved git toplevel into per-repo
lane groups and derive/provision geometry per group, all behind a new rollout flag that defaults
to today's reject. Happy-path only here — per-repo finalize FAILURE keying is task `.2`, the
merge-gate is `.3`, landed aggregation is `.4`.

### Approach

1. Add the rollout flag following the `worktree_mode` template EXACTLY: one nullable INTEGER
   column on `autopilot_state` via `addColumnIfMissing`, one entry in `AUTOPILOT_CONFIG_COLUMNS`
   (single source of truth for fold + RPC validator + mint), one parse clause in
   `extractAutopilotConfigSetPayload`, resolved `?? OFF` at read time (NEVER in a fold). If this
   requires a `SCHEMA_VERSION` bump, pair it with `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
   in the SAME commit.
2. Collapse the `ok` + `multi-repo` arms of `WorktreeRepoResolution` into ONE clustered arm
   carrying an ordered list of groups `{ repoDir, taskIds, mode: "worktree"|"serial" }` +
   `primaryRepoDir`. Keep `unresolved` / `no-primary-repo` / `disabled` arms verbatim. A
   single-repo epic is the 1-group case — ONE code path, not a special case.
3. In `classifyEpicRepo`: PRESERVE the existing precedence gates — any task with a null/empty
   root still short-circuits to whole-epic `unresolved`, and `projectDir === ""` to whole-epic
   `no-primary-repo` — BEFORE any partition. Only once every root resolves and a `primary_repo`
   exists do you partition. When the flag is OFF, `>1` distinct toplevel keeps returning the
   `multi-repo` reject (byte-identical). Assess worktree-eligibility per group (`assessRepo`), so
   one group can be `worktree` while a sibling is `serial`.
4. `prepareWorktreeGeometry` iterates GROUPS: call `deriveWorktreePlan(epicId, group.repoDir,
   group.taskIds→tasks)` per worktree group; for a serial group key its task+epic ids to the bare
   `repoDir` (the existing `disabled` cap-1 pattern). CRITICAL: in a mixed epic, keep each group's
   lane keys independent — a serial group's bare-`repoDir` key must never collide with a capable
   group's per-lane paths, and the single close row's key must resolve to the PRIMARY group's base
   lane. Confirm the grandfather predicate (`worktreeEpicGrandfathered`) runs per (epic, repoDir).
5. `attachWorktreeGeometry`: stamp `l.worktree` and push ONE `worktreeFinalize` entry PER GROUP
   (not per epic). Provision EVERY group's `__close__` sink lane (the rib→base fan-in is
   producer-side, via the existing `driver.provision` path) but dispatch the close WORKER only for
   the PRIMARY group. The finalize driver loop already iterates `decision.worktreeFinalize` and
   calls `finalizeEpic` per entry with `dir: info.repoDir` — no driver change, just more entries.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:700 — `WorktreeRepoResolution` union to collapse
- src/autopilot-worker.ts:2184 — `classifyEpicRepo` (reject :2221, precedence gates :2206-2250)
- src/autopilot-worker.ts:2348 — `prepareWorktreeGeometry` (disabled arm :2356, ok arm :2386; types :2309/:2316)
- src/autopilot-worker.ts:2441 — `attachWorktreeGeometry` (one finalize per ok epic :2528-2533; `epicOf` :2457)
- src/autopilot-worker.ts:2289 — `worktreeEpicGrandfathered` (already per (epicId, repoDir))
- src/worktree-plan.ts:202 — `deriveWorktreePlan` (:224 `parentsOf` already filters `depends_on` to in-group ids)
- src/reducer.ts:4631 — `AUTOPILOT_CONFIG_COLUMNS`; :4678 `extractAutopilotConfigSetPayload` null-safe coercion
- keeper/api.py — `SUPPORTED_SCHEMA_VERSIONS` whitelist

**Optional** (reference as needed):
- src/worktree-plan.ts — `baseBranchFor` / `ribBranchFor` / `worktreePathFor` / `CLOSE_SINK_ID` (per-repo path hashing already disambiguates same-basename repos)
- test/autopilot-worker.test.ts:3892/:3973/:4190 — the multi-repo reject tests to REPURPOSE; :4357 gate↔dispatch symmetry; `makeTask`:123 / `makeEpic`:139; git stubbed via `./helpers/fake-git`, NEVER real git
- test/worktree-plan.test.ts — pure `task()` builder; "byte-identical re-derivation" + "cycle fails loud" patterns

### Risks

- Re-fold determinism: clustering + per-group `deriveWorktreePlan` are PRODUCER-ONLY (touch git/fs). None may leak into a fold. `worktreePathFor` reads `homedir()` — safe only producer-side.
- Mixed-mode cap-1 keying collision (serial bare-`repoDir` key vs capable per-lane key vs the single close row's key) — the subtle failure mode; test it explicitly.
- The new asymmetry: non-primary groups provision a `__close__` sink but get no close worker — verify the fan-in still runs and finalize sees an assembled base, not an empty one.

### Test notes

Flip the reject tests (:3892/:3973/:4190) to assert per-group provisioning under the flag ON, and
add a flag-OFF case asserting the `>1` reject is unchanged. Extend the gate↔dispatch symmetry test
(:4357) per group. Add a mixed worktree+serial epic case asserting no lane-key collision. Add a
per-group `deriveWorktreePlan` case in worktree-plan.test.ts (cross-repo edge → dropped from
geometry). Sandbox `autopilot_state` for flag ON/OFF; `freshMemDb`/`freshDbFile` for folds.

### Detailed phases

1. Rollout flag (column + `AUTOPILOT_CONFIG_COLUMNS` + parse + schema/version parity) — lands green with no behavior change.
2. `WorktreeRepoResolution` clustered arm + `classifyEpicRepo` partition preserving precedence + flag gating.
3. `prepareWorktreeGeometry` / `attachWorktreeGeometry` per-group iteration + provision-every-sink / worker-only-primary.
4. Tests: repurpose rejects, symmetry per group, mixed-mode keying, per-group derivation.

## Acceptance

- [ ] Rollout flag added on `autopilot_state` via `set_autopilot_config` (no new RPC); `?? OFF` at read, never read in a fold; schema/version parity if bumped
- [ ] `classifyEpicRepo` partitions resolved-clean multi-repo epics into ordered per-repo groups behind the flag; `unresolved` / `no-primary-repo` stay whole-epic; flag OFF keeps the `>1` reject byte-identical
- [ ] `prepareWorktreeGeometry`/`attachWorktreeGeometry` iterate groups: per-group `deriveWorktreePlan`, one finalize entry per group, every group's `__close__` sink provisioned, close worker only for primary
- [ ] Mixed worktree+serial epic keys each group independently with no cap-1 collision; grandfather runs per (epic, repoDir)
- [ ] Single-repo epics remain byte-identical (existing worktree tests green unchanged)
- [ ] New + repurposed tests green; `test/schema-version.test.ts` green

## Done summary
Added the worktree_multi_repo rollout flag (default OFF) and, behind it, a clustered per-repo lane-group partition: classifyEpicRepo splits a resolved-clean multi-toplevel epic into ordered groups, prepareWorktreeGeometry/attachWorktreeGeometry derive+key geometry per group with one finalize per worktree group and the close worker only on the primary group (non-primary sinks fanned-in via provision before finalize); flag OFF and single-repo epics stay byte-identical.
## Evidence
