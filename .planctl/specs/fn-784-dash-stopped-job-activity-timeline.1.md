## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/reducer.ts, src/types.ts, src/collections.ts, test/reducer-lifecycle.test.ts, test/dash-view-model.test.ts

Add the folded `jobs.active_since REAL` (nullable) column and stamp it in
the reducer on the rising edge into `working`, then wire it all the way to
the dash snapshot. This is the contract-touching event-sourcing slice; the
dash sort/glyph work rides on top in task `.2`.

### Approach

Execute the 6-layer folded-column ritual (mirror the `last_input_request_at`
v24→v25 exemplar at `src/db.ts:2298-2302`):

1. **Schema** — add `active_since REAL` (bare nullable, no NOT NULL/DEFAULT) to the `jobs` CREATE TABLE alongside the other nullable REAL stamps (`src/db.ts:540-554`).
2. **Migration** — add `addColumnIfMissing(db, "jobs", "active_since", "REAL")` as the v64→v65 step, placed just before the `meta.schema_version` INSERT (`src/db.ts:3255`), INSIDE the `.immediate()` transaction, with a version comment restating the keeper-py coupling (style of `src/db.ts:2921-2935`). NO backfill.
3. **SCHEMA_VERSION** — bump `src/db.ts:48` from 64 to 65.
4. **keeper-py whitelist** — add `65` to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py:246` with a `# v65 …` prose note in the same style as the v64 note. MANDATORY same commit (host-wide fail-closed otherwise; `test/schema-version.test.ts` enforces).
5. **Wire boundary** — add `"active_since"` to the JOBS descriptor `columns` list in `src/collections.ts:69`. THIS IS THE EASY-TO-MISS LAYER: the server SELECTs exactly `descriptor.columns.join(", ")` (`src/server-worker.ts:1166`); omitting it means the column folds correctly but never reaches the snapshot — a silent failure that masquerades as "sort just uses created_at."
6. **Types** — add `active_since: number | null` to the TOP-LEVEL `Job` interface in `src/types.ts:254` (next to the other `last_*_at` fields). Do NOT add it to `EmbeddedJob` (`src/types.ts:526`) — that shape is not in the timeline sort and re-fold must not drift.

**The reducer stamp** goes in the UserPromptSubmit arm (`src/reducer.ts:5541-5557`, the sole `state='working'` writer). Add one clause to that existing UPDATE:

    active_since = CASE WHEN state != 'working' THEN ? ELSE active_since END

bound with the in-scope `ts` (the event's own timestamp). SQLite evaluates
SET RHS against pre-update row values, so `state` here is the OLD state:
the stamp re-fires on every `stopped→working` AND `ended/killed→working`
re-open, holds when already `working` (a 2nd prompt mid-run does NOT
re-promote), and the explicit `ELSE active_since` holds it otherwise. Mirror
the `start_time = CASE…END` pattern already in that UPDATE (`:5550-5553`).

Do NOT touch the Stop / SessionEnd / Killed arms (`:5677`, `:5696`, `:5760`)
or the SessionStart resume terminal→stopped flip (`:5422`) — none carry an
`active_since` clause, so the value is correctly HELD when a job goes
stopped/terminal or resumes-but-idle. Do NOT add `active_since` to the
SessionStart spawn-INSERT column list (`:5411`) — the column DEFAULT (NULL)
is the correct seed.

Finally, add `active_since: null` to the `makeJob` factory defaults in
`test/dash-view-model.test.ts:73-102` so the tree still typechecks after the
`Job` field lands (task `.2` adds the assertions that use it).

### Investigation targets

**Required** (read before coding):
- src/db.ts:540-554 — jobs CREATE TABLE (where the column goes)
- src/db.ts:2298-2302 — `last_input_request_at` migration exemplar
- src/db.ts:3248-3260 — tail of the migrate transaction + `meta.schema_version` INSERT
- src/db.ts:48 — `SCHEMA_VERSION`
- keeper/api.py:240-246 — `SUPPORTED_SCHEMA_VERSIONS` + v64 note style
- src/collections.ts:64-128 — JOBS descriptor (`columns` at :69, `defaultFilter` excludes ended/killed at :124)
- src/reducer.ts:5411-5557 — SessionStart spawn-INSERT, terminal→stopped resume flip, killed-notification suppression, and the UserPromptSubmit working arm
- src/types.ts:254 — top-level `Job` interface
- test/reducer-lifecycle.test.ts:330 — the re-fold determinism harness (rewind cursor + DELETE projections + re-drain, assert byte-identical)

**Optional** (reference as needed):
- src/server-worker.ts:1166 — proof the columns list is the SELECT boundary
- test/reducer-lifecycle.test.ts:45-52 — `insertEvent` helper + `tsCounter`

### Risks

- **Wire-boundary omission is silent** — if `src/collections.ts:69` is missed, the dash falls back to `created_at` for every row with no error. The reducer test can't catch this; task `.2`'s view-model test should assert `active_since` is delivered non-`undefined` on a wire row, but this task should at least eyeball the descriptor.
- **`test/db.test.ts` is already modified in the working tree** (pre-existing, unrelated to this epic). Do NOT revert or stage it; run `keeper commit-work --preview-files` and confirm only this task's files are staged.
- **`state = NULL` vs `state IS NULL`** is a non-issue here (`state` is NOT NULL), but use `!=` against the literal `'working'`, never `= NULL`-style comparisons elsewhere.

### Test notes

In `test/reducer-lifecycle.test.ts` add cases (using `insertEvent` + the
deterministic `tsCounter`):
- `active_since` is stamped = the UserPromptSubmit event `ts` on a first prompt (stopped/seed → working).
- It is HELD (unchanged) across a Stop→stopped, then across subagent/monitor activity (no re-stamp).
- It is RE-STAMPED to the new event `ts` on a genuine restart: `stopped → UserPromptSubmit`, AND on a `killed → UserPromptSubmit` re-open.
- It is NOT re-stamped by a 2nd UserPromptSubmit while already `working`.
- It is NOT stamped by a UserPromptSubmit that the killed-task-notification guard (`:5516`) swallows.
- Re-fold determinism: extend the `:330`-style rewind+DELETE+re-drain test so the byte-identical assertion set includes `active_since`, and add a "NULL `active_since` re-folds to NULL" case (a SessionStart-only job that never prompted).

## Acceptance

- [ ] `jobs.active_since REAL` exists in the CREATE TABLE and via an idempotent v64→v65 `addColumnIfMissing` migration (NULL default, no backfill).
- [ ] `SCHEMA_VERSION` is 65 and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` contains 65 in the same commit; `test/schema-version.test.ts` green.
- [ ] The UserPromptSubmit arm stamps `active_since = event.ts` only on the rising edge into `working` (`state != 'working'` CASE), held otherwise; Stop/SessionEnd/Killed/resume arms untouched.
- [ ] `active_since` is on the top-level `Job` interface, the `src/collections.ts` JOBS `columns` list, and the `makeJob` test factory; not on `EmbeddedJob`.
- [ ] Reducer tests cover stamp / hold / re-stamp-on-restart / no-restamp-mid-run / suppression / re-fold determinism (incl. NULL→NULL); `bun run test:full` green.

## Done summary

## Evidence
