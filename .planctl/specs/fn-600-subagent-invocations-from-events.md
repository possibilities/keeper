## Overview

Port jobctl's subagent_invocations capture into keeperd as a peer-table-backed
projection of per-job `Agent` (Task) tool invocations and their
`SubagentStart`/`SubagentStop` lifecycle. The data is already in the event log
(four hook events + the `subagent_agent_id` bridge column populated since
fn-390); this epic adds the sparse `events.tool_use_id` column, the projection
table, the wire collection, and a TS port of the jobctl Python parser with
golden-fixture parity tests.

Hard-depends on fn-598-creator-refiner-from-planctl-invocations — fn-598's
sparse-columns + partial-index conventions are the precedent, and this epic's
v15 schema slot follows fn-598's v14. fn-598 must merge before any task here
starts; tasks below assume fn-598's schema migration, hook wiring, reducer
fan-out, and README/CLAUDE "sparse signals" enumeration are landed.

## Quick commands

- `bun test test/subagent-invocations.test.ts test/reducer.test.ts test/db.test.ts test/derivers.test.ts test/events-writer.test.ts`
- `sqlite3 ~/.local/state/keeperd/keeper.db "SELECT job_id, agent_id, turn_seq, status, subagent_type, duration_ms FROM subagent_invocations LIMIT 10"`
- `sqlite3 ~/.local/state/keeperd/keeper.db "SELECT COUNT(*) FROM events WHERE tool_use_id IS NOT NULL"`

## Acceptance

- [ ] Every `Pre/PostToolUse` event (and `PostToolUseFailure`) lands with `events.tool_use_id` populated when `data.tool_use_id` is a non-empty string; all other event rows stay NULL.
- [ ] A session that spawns an Explore subagent (Pre + Start + Stop + Post) lands one row in `subagent_invocations` with `status='ok'`, populated `description` + `prompt_chars` + `tool_use_id` + non-null `duration_ms`, and `subagent_type='Explore'`.
- [ ] A still-open subagent (Pre + Start, no Stop) lands one row with `status='running'`, `duration_ms=NULL`.
- [ ] An orphan `SubagentStop` (no matching open Start) folds to a safe no-op — cursor advances, no row mutation, no throw.
- [ ] `PostToolUseFailure:Agent` folds to a safe no-op — cursor advances, no row mutation.
- [ ] Re-fold determinism: rewind `reducer_state.last_event_id` to 0, `DELETE FROM subagent_invocations`, drain to completion — table content matches byte-for-byte.
- [ ] Wire subscribe to the `subagent_invocations` collection filtered on a `job_id` returns the per-job timeline and emits patch frames as rows transition `running → ok` and `duration_ms` populates on SubagentStop.
- [ ] Coexistence with fn-598: a session that runs both planctl invocations and Agent calls keeps both projections populated, both deterministic on re-fold.
- [ ] Forward-only migration on an already-migrated DB is a no-op.
- [ ] Golden fixture `test/fixtures/subagent_invocation_cases.jsonl` passes byte-identical parity against the Python `subagent_invocations.py:parse_rows` reference (modulo the dropped `tokens` / `tool_use_count` fields).
- [ ] `planctl validate --epic <epic_id>` passes.

## Early proof point

Task that proves the approach: `<epic_id>.2` — the TS parser port. If parity fails against the Python-generated golden fixture, walk the diff entry-by-entry against the Python source until matched. The rest of the epic is mechanical wiring on top of that parity guarantee.

## References

- jobctl Python source: `/Users/mike/code/arthack/apps/cli_common/cli_common/subagent_invocations.py:1-646` — the reference implementation. Port wholesale to TS minus `tokens` / `tool_use_count`.
- fn-598-creator-refiner-from-planctl-invocations — hard dependency. The five `planctl_*` sparse columns and `syncPlanctlLinks` fan-out are the established precedent; this epic mirrors the sparse-column shape (`events.tool_use_id`) and the partial-index pattern.
- keeper invariants: `/Users/mike/code/keeper/CLAUDE.md` — "cursor + projection advance in the same `BEGIN IMMEDIATE` transaction", "byte-identical re-fold", "no third-party deps in the hook", "schema defaults match the zero-event projection".
- keeper v9→v10 migration precedent: `src/db.ts:612-708` — same-transaction backfill template via uncached `db.run(sql, params)` (bun:sqlite cache-pin workaround for oven-sh/bun#1332).
- keeper v10→v11 re-fold precedent: `src/db.ts:738-749` — rewind cursor + `DELETE FROM projection` + boot drain repopulates. This is how task .1 backfills historical subagent_invocations rows.
- bridge column precedent: `events.subagent_agent_id` populated by `extractSubagentAgentId` at `plugin/hooks/events-writer.ts:88-104`. The PostToolUse:Agent fold reads it first; falls back to `json_extract(data, '$.tool_response.agentId')` for historical rows.
- jobctl primer: `/Users/mike/docs/jobctl-and-hooks-tracker-primer.md` — cross-system map between jobctl + hooks-tracker.db + keeper.

## Docs gaps

- **`README.md`**: extend the "sparse signals" paragraph (lines 27-31) to add `events.tool_use_id` as a third sparse top-level column alongside `slash_command` and `skill_name`. Revise the "Two collections register today" sentence (lines 51-57 and Architecture lines 314-327) to name `subagent_invocations` as the third collection. Add representative `SELECT` queries against `subagent_invocations` and `events WHERE tool_use_id IS NOT NULL` to the Inspect section (lines 389-424). Name `events.tool_use_id` in the Architecture events-table description (lines 303-309).
- **`CLAUDE.md`**: add `subagent_invocations` to the "cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction" bullet's parenthetical listing of projections. No new DO NOT entry needed — pure projection under existing rules. No new synthetic-event entry needed — SubagentStart/Stop and PostToolUse:Agent are existing hook events.

## Best practices

- **Uncached `db.run(sql, params)` for the migration backfill**, not `db.prepare().run()`. The bun:sqlite statement cache compiled inside a transaction that just ran ALTER can pin pre-ALTER schema metadata (oven-sh/bun#1332 — the v9→v10 backfill at `src/db.ts:612-708` is the canonical template).
- **Partial-index predicate must syntactically match the consumer WHERE.** `CREATE INDEX idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL` paired with `WHERE tool_use_id = ?` hits SQLite partialindex.html Rule 2 (IS NOT NULL implication). Never change a partial-index WHERE in place — DROP+CREATE if it ever shifts.
- **`ANALYZE events;` once at migration time** so the planner picks the new partial index on first query post-upgrade.
- **Reducer fold never throws inside `BEGIN IMMEDIATE`.** Every new switch arm wraps parse/lookup in try/safe-default. A throw rolls back the cursor and wedges the reducer.
- **Cross-job isolation in the bridge lookup.** The PostToolUse:Agent fold has the originating event's `session_id` (= job_id) — include it in the PreToolUse lookup WHERE to prevent cross-job contamination.
- **Golden-fixture canonicalization.** Python's `json.dumps(sort_keys=True, separators=(',',':'))` produces the canonical form. The TS test must match byte-for-byte — compare serialized strings, never deep equality, so column-name typos or extra fields fail loudly.
- **Per-row `last_event_id` bump on every UPDATE.** Every reducer arm that mutates a `subagent_invocations` row bumps `last_event_id` to the firing event's id so the diff-version semantics emit patches to wire subscribers.
- **PostToolUse:Agent fires BEFORE SubagentStop for Task tool calls** (Anthropic-confirmed; jobctl fn-480). SubagentStop UPDATE gates on `duration_ms IS NULL` ALONE — never also on `status='running'`.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/keeper-subagent-invocations` — author-tier handoff bundle from the upstream sketch. Empty snippet set today; rides forward so future `render-spec` calls resolve any additions made post-handoff.
