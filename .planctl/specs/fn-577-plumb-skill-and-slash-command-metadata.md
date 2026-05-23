## Overview

Index skill and slash-command metadata so `plan:{plan,work,close}`
invocations can be associated with `jobs` without JSON-scanning
`events.data`. Adds four columns — `events.slash_command`,
`events.skill_name`, `jobs.plan_verb`, `jobs.plan_ref` — populated by
pure derivations at hook-insert and reducer-fold time. Forward-only
schema migration mirroring the v3→v4 `spawn_name` + `title_source`
precedent exactly: ALTER + `addColumnIfMissing` + partial indexes +
same-transaction `BEGIN IMMEDIATE` backfill + `SCHEMA_VERSION` bump.

The two pairs cover the two distinct skill surfaces seen in keeper's
event log today:

- `events.slash_command` + `events.skill_name` index *every*
  slash-command and Skill-tool invocation across all events. Catches
  mid-session `/plan:plan` Skill calls inside interactive sessions
  (which don't change `spawn_name`).
- `jobs.plan_verb` + `jobs.plan_ref` project the spawn-named
  `work::fn-X.Y` / `close::fn-X` jobs into queryable columns derived
  at SessionStart from existing `spawn_name`. Strict whitelist:
  `{plan, work, close}` (no `audit`).

## Quick commands

```sh
# Associate plan invocations with jobs — indexed, no JSON scan:
sqlite3 ~/.local/state/keeper/keeper.db "
  SELECT job_id, title, plan_verb, plan_ref
  FROM jobs
  WHERE plan_verb IN ('plan','work','close')
  ORDER BY updated_at DESC LIMIT 10
"

# All Skill-tool plan:plan invocations across sessions:
sqlite3 ~/.local/state/keeper/keeper.db "
  SELECT session_id, datetime(ts,'unixepoch','localtime'), skill_name
  FROM events
  WHERE skill_name LIKE 'plan:%'
  ORDER BY id DESC LIMIT 20
"

# Confirm partial indexes are used (expect SEARCH USING INDEX):
sqlite3 ~/.local/state/keeper/keeper.db \
  "EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE plan_verb='close'"
```

## Acceptance

- [ ] Migration is idempotent: a fresh DB and a v8→v9-migrated DB
  converge to identical schema (per `CREATE_EVENTS`/`CREATE_JOBS`
  literal-vs-`addColumnIfMissing` lockstep convention).
- [ ] Same-transaction backfill populates existing event and job rows;
  `EXPLAIN QUERY PLAN` confirms the partial indexes serve the new
  `WHERE plan_verb=…` / `WHERE skill_name LIKE 'plan:%'` queries.
- [ ] Re-fold idempotency: rewind cursor + `DELETE FROM jobs` +
  drain reproduces byte-identical jobs rows, including the new
  `plan_verb` / `plan_ref` columns.
- [ ] Hook stays exit-0 and zero-new-deps (`bun:sqlite` + local files
  only); SessionEnd hook timing budget respected.
- [ ] Read-surface continuity: `JOBS_DESCRIPTOR.columns` includes the
  new jobs columns; existing subscribers see the new fields without
  any wire-protocol change.

## Early proof point

Task that proves the approach: `<epic_id>.1` (the sole task). If the
migration test fails on backfill, revise the backfill SQL; if a
parser unit test fails on payload shape, re-verify the wire format
against a live `data.prompt` / `data.tool_input.skill` sample (the
payload shapes were verified empirically against the current event
log during planning, but the check should run again if anything
looks off).

## References

- v3→v4 ALTER block at `src/db.ts:422-429` — closest end-to-end
  precedent (same shape: two `addColumnIfMissing` calls, lockstep
  literal update, same migration test pattern).
- SQLite partial-index §2 Rule 2 (sqlite.org/partialindex.html) —
  planner auto-matches any comparison on the indexed column when the
  predicate is `WHERE x IS NOT NULL`. The reason these are partial
  indexes, not full indexes.
- oven-sh/bun#1332 — Bun statement-cache invalidation gotcha; still
  open. Our `migrate()` runs before workers spawn and before main
  caches `stmts.insertEvent`, so the gotcha is avoided by ordering,
  not by bug-fix. Confirm the order doesn't drift.

## Docs gaps

- **`/Users/mike/code/keeper/README.md`** — Architecture section
  (lines 232-293) lists jobs columns inline (`state`/`title`/
  `title_source`); add `plan_verb` and `plan_ref` to the inventory
  and note they're derived at SessionStart from `spawn_name`. Inspect
  section (lines 296-315) shows an example `SELECT` on jobs; extend
  or replace with a query demonstrating the new indexed lookup
  (`WHERE plan_verb='close'`) plus one against
  `events.skill_name LIKE 'plan:%'`. Revise the existing prose, don't
  append.

## Best practices

- **Same-transaction backfill** keeps the migration atomic —
  `BEGIN IMMEDIATE` rolls back ALTERs and backfill together on any
  failure. [sqlite.org/lang_altertable.html]
- **Partial index `WHERE x IS NOT NULL`** is the killer pattern for
  sparse TEXT columns; SQLite auto-matches any comparison on the
  indexed column without textual-predicate match.
  [sqlite.org/partialindex.html §2 Rule 2]
- **Compile-once regex at module scope** lets V8/JSC tier-up fire.
  Re-creating the literal each hook invocation defeats it.
  [v8.dev/blog/regexp-tier-up]
- **Don't share long-lived prepared statements across an ALTER** —
  Bun's statement cache isn't invalidated on schema change
  (oven-sh/bun#1332, still open). Safe here by ordering: `migrate()`
  runs before workers spawn and before main caches its `INSERT`.
