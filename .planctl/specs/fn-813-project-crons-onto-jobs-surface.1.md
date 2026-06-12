## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/types.ts, src/collections.ts, keeper/api.py, test/reducer-projections.test.ts, test/collections.test.ts

### Approach

Add the `scheduled_tasks` side table and its fold, mirroring `subagent_invocations`
end to end. Schema v68: `CREATE_SCHEDULED_TASKS` const + `CREATE_SCHEDULED_TASKS_INDEXES`
array near src/db.ts:492-512, wired into the migrate transaction (src/db.ts:1480-1523);
`CREATE TABLE IF NOT EXISTS` is idempotent so no version guard (v57 `event_blobs`
precedent at src/db.ts:3177-3180). Columns: `job_id TEXT NOT NULL`, `cron_id TEXT NOT NULL`,
`cron TEXT NOT NULL DEFAULT ''`, `human_schedule TEXT NOT NULL DEFAULT ''`,
`recurring INTEGER NOT NULL DEFAULT 0`, `durable INTEGER NOT NULL DEFAULT 0`,
`prompt_summary TEXT NOT NULL DEFAULT ''`, `status TEXT NOT NULL DEFAULT 'active'`,
`ts REAL NOT NULL`, `last_event_id INTEGER NOT NULL`, `updated_at REAL NOT NULL`,
`PRIMARY KEY (job_id, cron_id)` — defaults match the zero-event projection.

New `projectScheduledTasksRow` beside `projectSubagentInvocationsRow`, called as a
sibling at the PostToolUse dispatch site (src/reducer.ts:6852-6872 arm — cron events
are PostToolUse, the :6918 else arm never sees them). Gate: `hook_event === 'PostToolUse'`
strictly (PostToolUseFailure carries no tool_response and must never mint a row), then
`tool_name === 'CronCreate' || 'CronDelete'`. Parse `event.data` defensively (try/catch +
return pattern, src/reducer.ts:252-261); missing `tool_response.id` (create) or
`tool_input.id` (delete) → guard-and-return no-op, cursor still advances. Never throw.

Create arm: `INSERT ... ON CONFLICT(job_id, cron_id) DO UPDATE SET` all payload fields
AND `status='active'` — a re-created cron id resurrects. `prompt_summary` = first line
of `tool_input.prompt`, capped at 200 chars (deterministic truncation in the fold is
fine; wall-clock is not). Delete arm: `UPDATE ... SET status='deleted', last_event_id,
updated_at WHERE job_id=? AND cron_id=?` — unmatched key is a no-op (crons are
session-scoped; cross-session deletes don't occur for non-durable crons). All
timestamps from `event.ts`; both arms bump `last_event_id` so the wire diff fires.

Collection descriptor `SCHEDULED_TASKS_DESCRIPTOR` copied from
`SUBAGENT_INVOCATIONS_DESCRIPTOR` (src/collections.ts:344-367): `pk: "job_id"`
(single-column wire identity over the composite SQL key), `version: "last_event_id"`,
`filters: { job_id }`; register in the REGISTRY map (src/collections.ts:566-579).
Add a `ScheduledTask` interface beside `SubagentInvocation` (src/types.ts:582-595).
Bump `SCHEMA_VERSION` to 68 (src/db.ts:50) and add `68` with a one-line prose comment
to `SUPPORTED_SCHEMA_VERSIONS` (keeper/api.py:259-264) in this same commit.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3816-3944 — projectSubagentInvocationsRow + tool gate: the exact INSERT/UPDATE, null-guard, and event.ts/event.id shape to mirror
- src/reducer.ts:6852-6918 — the two dispatch sites; the sibling call goes in the PostToolUse arm only
- src/collections.ts:344-367, :566-579 — descriptor template + registry
- src/db.ts:50, :492-512, :1480-1523 — version const, DDL constants, migrate transaction
- keeper/api.py:258-264 — whitelist frozenset + per-version comment style

**Optional** (reference as needed):
- src/db.ts:3177-3180 — v57 event_blobs precedent for a new idempotent side table
- src/subagent-invocations.ts — the parser/parity split; cron extraction is small enough to inline in the fold, but follow this if a helper module reads cleaner
- test/helpers/template-db.ts — freshDb()/freshDbFile() for in-process fold tests

### Risks

- The descriptor's wire pk is `job_id` but the SQL key is composite — server-side this is fine (subagents prove it), but it constrains the client task to read `state.rows`, not `byId`. The contract must hold or crons silently collapse to one per job.
- Payload drift: if a future harness version moves the cron id, the guard-and-return no-op means rows silently stop appearing — acceptable (fail-quiet matches fold rules), noted here so a red fold test points at the payload first.

### Test notes

Fold tests in test/reducer-projections.test.ts via the template-DB helper: create→row
active; delete→status flips; delete-without-create→no-op; create-after-delete→resurrects;
malformed/missing-id payloads→no-op with cursor advance; PostToolUseFailure→no row;
re-fold from scratch reproduces identical rows. Descriptor/registry coverage in
test/collections.test.ts. `bun run test:full` mandatory (db/reducer paths).

## Acceptance

- [ ] Schema v68 creates `scheduled_tasks` with defaults matching the zero-event projection; `test/schema-version.test.ts` green (api.py bumped same commit)
- [ ] CronCreate folds to an active row (upsert resurrects deleted ids); CronDelete flips the matching row to deleted; unmatched delete and malformed payloads fold to no-ops with the cursor advancing; PostToolUseFailure never mints a row
- [ ] `scheduled_tasks` collection queryable over the socket filtered by `job_id`, versioned on `last_event_id`
- [ ] From-scratch re-fold reproduces identical rows (fold test proves it)
- [ ] `bun run test:full` green

## Done summary

## Evidence
