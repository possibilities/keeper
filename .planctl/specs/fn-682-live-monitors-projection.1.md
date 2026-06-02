## Description

**Size:** M
**Files:** src/db.ts, src/derivers.ts, plugin/hooks/events-writer.ts, src/reducer.ts, keeper/api.py, test/derivers.test.ts, test/reducer.test.ts, test/schema-version.test.ts

### Approach

Build the full event-sourcing pipeline that produces a correct per-job `jobs.monitors` JSON-array column. Three layers:

1. **Schema v50→v51** (src/db.ts): bump `SCHEMA_VERSION` (line 60). Add `monitors TEXT NOT NULL DEFAULT '[]'` literal to `CREATE_JOBS` (~661, after `backend_exec_tab_name`) + an `addColumnIfMissing(db,"jobs","monitors","TEXT NOT NULL DEFAULT '[]'")` migrate slot (model: name_history v39→v40 ~4341). Add a derived events column `background_task_id TEXT` to the events CREATE + its own `addColumnIfMissing` slot, plus a partial index on `(session_id, background_task_id) WHERE background_task_id IS NOT NULL` for the in-fold provenance scan. Add the v50→v51 prose block before the `meta` schema_version stamp (~4890). Add `51` to keeper/api.py `SUPPORTED_SCHEMA_VERSIONS` (~160) + a whitelist-only comment — in the SAME change (hard invariant).

2. **Deriver + hook stamp** (src/derivers.ts, plugin/hooks/events-writer.ts): new pure `extractBackgroundTaskId(hookEvent, toolName, data)` (model: `extractBashMutation` gating + `PlanctlInvocation.files` defensive lift). Returns `tool_response.taskId` on PostToolUse+Monitor, `tool_response.backgroundTaskId` on PostToolUse+Bash, else null; non-string/missing → null, never throw. Stamp into `events.background_task_id` at the hook INSERT (hook is the sole writer of hook events; keep imports `bun:sqlite` + local only; the fn-669 known∩live narrowing must still land the row NULL against a behind-schema DB). Version-guarded backfill in `migrate()` re-derives the column for historical Monitor/Bash PostToolUse rows using the SAME pure deriver — guard `if (preMigrateStoredVersion < 51)` — so a cursor=0 re-fold reproduces identical provenance.

3. **Reducer fold** (src/reducer.ts):
   - New pure `extractBackgroundTasks(data)` — defensive lift of `data.background_tasks`, filter `type === "shell"` (allowlist, not a `!== "subagent"` denylist), cap (~50), stable sort by id; non-array / malformed / missing → `[]`. NEVER throw.
   - Stop arm (~6201): hoist a snapshot-replace of `jobs.monitors` ABOVE the subagent-running guard (~6260-6284) so a guard-swallowed Stop still refreshes. Build the new array from `extractBackgroundTasks` of THIS Stop's data; for each shell entry resolve provenance via an in-fold scan `SELECT background_task_id, tool_name FROM events WHERE session_id=? AND background_task_id IS NOT NULL AND id < <currentEventId>` → `Map<id, 'monitor'|'bash-bg'>` (tool_name Monitor→monitor, Bash→bash-bg); entry id in map → that kind, else `ambient`. Full-array UPDATE in the same `BEGIN IMMEDIATE`. Empty/missing `background_tasks` → write `'[]'` (drop-when-dead; the snapshot paradox — never no-op on empty).
   - SessionEnd (~6299) and Killed (~6318) arms: clear `monitors` to `'[]'` (a terminal job has no live monitors).
   - Provenance is recomputed each Stop from the events scan (deterministic — reads the immutable log, id<current). NO carry-forward carve-out.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6775-6816 — name_history fold write (in-txn read→compute→UPDATE shape)
- src/reducer.ts:6835-6862 — appendNameHistory (pure defensive-parse helper model)
- src/reducer.ts:6201-6320 — Stop / SessionEnd / Killed arms + subagent guard (6260-6284)
- src/reducer.ts:1392 — computeRepoBashWindows (in-fold events-scan precedent, index-narrowed)
- src/derivers.ts:338-368, 426, 1013 — PlanctlInvocation.files cap lift, extractPlanctlInvocation, extractBashMutation
- src/db.ts:60, 639-667, 4341-4364, 4857-4890 — SCHEMA_VERSION, CREATE_JOBS, name_history slot, v49→v50 slot
- keeper/api.py:153-162 — SUPPORTED_SCHEMA_VERSIONS + comment block

**Optional**:
- src/derivers.ts:209-233 — stale Monitor-kill reference (check for existing partial Monitor handling)
- src/reducer.ts:4125-4152 — buildEmbeddedJob (confirm the embedded job element does NOT need monitors)

### Risks

- In-fold events scan over the ~1.2 GB events table MUST be index-backed (partial index on session_id, background_task_id); without it the scan is sequential inside BEGIN IMMEDIATE.
- Historical Stop events already carry `background_tasks` in their data, so a re-fold WILL populate monitors for past sessions — the `background_task_id` backfill is therefore required for provenance determinism (shared pure deriver, version-guarded).
- Hook must stay dep-free and exit 0; a behind-schema INSERT must still land (the new column NULL).
- Re-fold determinism: no Date.now/env/fs/liveness in any fold; stable sort for the monitors array.

### Test notes

- test/derivers.test.ts: `extractBackgroundTaskId` (Monitor taskId, Bash backgroundTaskId, non-matching tool, missing/non-string, malformed) + `extractBackgroundTasks` (shell allowlist, subagent drop, empty/missing/malformed→[], cap, stable sort).
- test/reducer.test.ts (model: name_history block ~12653): Stop seeds monitors; empty background_tasks drops to []; three-way provenance (monitor/bash-bg/ambient); SessionEnd/Killed clear; cursor=0 re-fold byte-identical (incl. backfill convergence); malformed data folds safe + cursor advances.
- test/schema-version.test.ts green (51 in both db.ts and api.py).

## Acceptance

- [ ] SCHEMA_VERSION=51; jobs.monitors + events.background_task_id columns + the partial index land on fresh AND migrated DBs (literal + addColumnIfMissing lockstep).
- [ ] keeper/api.py SUPPORTED_SCHEMA_VERSIONS includes 51; test/schema-version.test.ts passes.
- [ ] A Stop's background_tasks (type:shell only) folds into jobs.monitors with three-way provenance (monitor / bash-bg / ambient).
- [ ] Empty / missing / malformed background_tasks → jobs.monitors='[]'; SessionEnd / Killed → '[]'.
- [ ] cursor=0 re-fold reproduces byte-identical jobs.monitors (backfill + deriver converge); no fold reads wall-clock/env/fs.
- [ ] bun test green.

## Done summary

## Evidence
