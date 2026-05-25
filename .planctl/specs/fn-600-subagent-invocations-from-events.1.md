## Description

**Size:** M
**Files:** src/db.ts, src/derivers.ts, plugin/hooks/events-writer.ts, src/types.ts, test/derivers.test.ts, test/db.test.ts, test/events-writer.test.ts

### Approach

Add the foundation schema + bridge wiring that everything else builds on. Self-contained: after this task lands, `events.tool_use_id` is live and populated (forward + backfill), `subagent_invocations` exists as an empty peer table, and the hook writes the new column. No reducer fold logic yet — task .3 supplies those.

Adds:
- `events.tool_use_id TEXT` sparse top-level column with partial index `WHERE tool_use_id IS NOT NULL`. Mirrors the v10 sparse-column + partial-index precedent (`slash_command`, `skill_name`).
- `subagent_invocations` peer table with composite PK `(job_id, agent_id, turn_seq)`. Columns: `job_id TEXT NOT NULL`, `agent_id TEXT NOT NULL`, `turn_seq INTEGER NOT NULL`, `ts REAL NOT NULL`, `tool_use_id TEXT`, `subagent_type TEXT`, `description TEXT`, `prompt_chars INTEGER NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'running'`, `duration_ms INTEGER`, `last_event_id INTEGER NOT NULL`, `updated_at REAL NOT NULL`. Index `idx_subagent_invocations_job ON subagent_invocations(job_id)` for the per-job subscribe path. Defaults match the zero-event projection (`status='running'` is the SubagentStart-time value).
- `extractToolUseId(data)` pure deriver in `src/derivers.ts` — gated only on `data.tool_use_id` being a non-empty string; shape-defensive (returns null on non-string / missing / empty), never throws. Mirrors `extractSkillName` / `extractSubagentAgentId`. Fires for every event that carries `data.tool_use_id` (Pre/PostToolUse/PostToolUseFailure across all tools — not just Agent).
- Hook wires the deriver via a new `$tool_use_id` named param on the events INSERT. No new third-party deps; hook exit-0 contract preserved.
- `Event.tool_use_id: string | null` field in `src/types.ts`; new `SubagentInvocation` type alongside `EmbeddedJob`.
- v14→v15 migration block in `migrate()` (positioned AFTER fn-598's v14 step):
  1. `addColumnIfMissing(db, "events", "tool_use_id", "TEXT")`
  2. CREATE TABLE subagent_invocations + CREATE INDEX idx_subagent_invocations_job (idempotent IF NOT EXISTS)
  3. CREATE INDEX idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL (idempotent)
  4. Backfill historical events.tool_use_id via uncached `db.run("UPDATE events SET tool_use_id = json_extract(data, '$.tool_use_id') WHERE tool_use_id IS NULL AND json_extract(data, '$.tool_use_id') IS NOT NULL")` — version-guarded.
  5. `db.run("ANALYZE events")` once so the planner picks the new partial index on first query post-upgrade.
  6. Rewind: `UPDATE reducer_state SET last_event_id = 0`, `DELETE FROM subagent_invocations`. Boot drain re-folds — task .3's reducer cases populate the projection on the re-drain.
  7. Bump `SCHEMA_VERSION` to 15.
- The CREATE_EVENTS literal gains the new `tool_use_id` column for fresh-DB convergence with the migrated path. CREATE_EVENTS_INDEXES does NOT (partial index lives in the v15 block since it depends on the addColumnIfMissing).
- `prepareStmts.insertEvent` named-binding stmt gains `$tool_use_id`. `drain()`'s SELECT projection appends `tool_use_id` so the `Event` cast stays complete.

The intermediate post-task-.1 state is harmless: `subagent_invocations` exists but is empty (no reducer cases yet); the wire collection isn't registered (task .3 adds the descriptor); `events.tool_use_id` is populated forward + backfilled. After task .3 lands, the re-fold populates the projection.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:225-244` — CREATE_EVENTS literal; add `tool_use_id TEXT` column.
- `src/db.ts:275-279` — CREATE_V10_INDEXES; precedent for placing the new partial index in a v15 block.
- `src/db.ts:380-398` — `addColumnIfMissing` primitive.
- `src/db.ts:427-...` — `migrate()`; add the v14→v15 block AFTER fn-598's v14 step. Confirm the actual upstream version number when reading fn-598's merged migration.
- `src/db.ts:612-708` — v9→v10 backfill template (uncached `db.run`, bun:sqlite cache-pin workaround for oven-sh/bun#1332). Mirror this pattern verbatim.
- `src/db.ts:738-749` — v10→v11 re-fold precedent (rewind cursor + DELETE FROM projection). Mirror.
- `src/db.ts:864-878` — `prepareStmts.insertEvent` named-binding stmt; add `$tool_use_id`.
- `src/derivers.ts:88-132` — extractSlashCommand / extractSkillName template.
- `src/derivers.ts:391-432` — extractPlanctlInvocation (fn-598 sibling) for gate + shape-defensive pattern.
- `plugin/hooks/events-writer.ts:88-104` — extractSubagentAgentId hook-side precedent.
- `plugin/hooks/events-writer.ts:303-375` — `main()` writer; add deriver call alongside extractSkillName; add `$tool_use_id` to INSERT params.
- `src/types.ts:19-34` — `Event` interface (add `tool_use_id`).
- `test/derivers.test.ts` — unit-test pattern for the new pure deriver.
- `test/db.test.ts` — migration test pattern.

**Optional** (reference as needed):
- `/Users/mike/code/arthack/apps/cli_common/cli_common/subagent_invocations.py:130-153` — Python's `EVENTS_SELECT_COLS` showing `tool_use_id` lives in a `data.tool_use_id` json_extract on the Python side; we promote it to a top-level column in keeper.

### Risks

- **fn-598 schema version coordination.** This task assumes fn-598's v13→v14 step is upstream. If fn-598's task .3 ships under a different version number, ours must follow that actual version + 1. Confirm against fn-598's merged state before writing the migration block — `git log src/db.ts` against the merged tree.
- **events.tool_use_id population for non-Agent tools.** Bash/Read/Edit Pre/PostToolUse rows also carry `data.tool_use_id`. The column populates for all of them, growing the partial-index size beyond just Agent rows. Intentional (canonical deriver shape, reusable for future tool-keyed projections); verify the partial-index size stays acceptable on a months-old events log.
- **Backfill on a large events log.** The UPDATE-from-json_extract walks every row. For a months-old DB with millions of events this can take seconds. Wrap in the version-guarded block so a re-run on an already-migrated DB short-circuits.
- **Rewind cursor without reducer cases (intermediate state between this task and task .3).** Between this task landing and task .3 landing, daemon boot re-drains from 0 WITHOUT populating subagent_invocations (no cases yet). Harmless for the projection (stays empty) but the existing jobs / epics folds also re-fold — verify they tolerate a fresh re-fold cleanly (they already do per the v10→v11 precedent).
- **`prompt_chars` data shape.** Python's `EVENTS_SELECT_COLS` projects `length(json_extract(e.data, '$.tool_input.prompt'))`. We read at fold time (in task .3) via JSON parse of the PreToolUse row's `data`. No new column needed in this task.

### Test notes

- `test/derivers.test.ts`: cover `extractToolUseId({tool_use_id: "toolu_abc"})` → `"toolu_abc"`; `extractToolUseId({})` → `null`; `extractToolUseId({tool_use_id: 42})` → `null` (non-string); `extractToolUseId({tool_use_id: ""})` → `null` (empty); `extractToolUseId(null)` → `null`.
- `test/db.test.ts`: cover v14→v15 — fresh DB lands the column + tables + indexes; a seeded v14-shaped DB migrates idempotently; re-run on v15 is a no-op; backfill populates historical events.tool_use_id from json_extract.
- `test/events-writer.test.ts`: hook fires for a PreToolUse:Bash event with `tool_use_id` → events row carries `tool_use_id` populated.

## Acceptance

- [ ] `events.tool_use_id TEXT` column exists post-migration; CREATE_EVENTS literal carries it for fresh-DB convergence.
- [ ] Partial index `idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL` exists.
- [ ] `subagent_invocations` table exists with composite PK `(job_id, agent_id, turn_seq)` and the listed columns + defaults.
- [ ] Index `idx_subagent_invocations_job ON subagent_invocations(job_id)` exists.
- [ ] `extractToolUseId(data)` returns the tool_use_id string for valid input and null for any non-string / missing / empty case; never throws.
- [ ] Hook writes `$tool_use_id` on every events INSERT; column is non-NULL for Pre/PostToolUse/PostToolUseFailure when the payload carries it, NULL otherwise.
- [ ] `SCHEMA_VERSION` bumped to 15 (one past fn-598's 14). Migration on a fresh v14 DB lands all changes; re-run on v15 is a no-op.
- [ ] Backfill populates `events.tool_use_id` for historical rows where `data.tool_use_id` is present; events without it stay NULL.
- [ ] `ANALYZE events;` runs once in the migration block.
- [ ] `Event` interface adds `tool_use_id: string | null`; new `SubagentInvocation` type defined in `src/types.ts`.
- [ ] Migration rewinds `reducer_state.last_event_id` to 0 and deletes from `subagent_invocations`; boot drain runs to completion without error (with empty projection until task .3 lands).
- [ ] `bun test test/derivers.test.ts test/db.test.ts test/events-writer.test.ts` passes.

## Done summary
Added schema v17: sparse events.tool_use_id column with partial index, empty subagent_invocations peer table (composite PK), extractToolUseId deriver wired into the hook + migration backfill via json_extract (json_valid-gated), and rewind-and-redrain so the boot drain rebuilds the projection.
## Evidence
