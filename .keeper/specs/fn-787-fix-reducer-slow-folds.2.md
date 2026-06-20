## Description

**Size:** S
**Files:** src/subagent-invocations.ts, src/db.ts (only if an index is needed), keeper/api.py (only with a schema bump)

### Approach

EQP-proven planner miss: `findPendingPreToolUseForStart`
(src/subagent-invocations.ts:345) seeks `idx_events_hook_event (hook_event=?)`
— every PreToolUse row in the DB per SubagentStart, with session/tool_name as
row filters and a correlated scalar subquery per row. Fix so the seek is
session-anchored. Try in order: (1) refresh stats (`ANALYZE events` /
`PRAGMA optimize`) and re-EQP — stats are stale since the last migration and
may alone flip the plan; (2) rewrite the query shape so an existing
session-anchored index wins; (3) add a composite partial index (e.g.
`(session_id, tool_use_id) WHERE hook_event='PreToolUse' AND
tool_name='Agent'`) — this triggers the full migration ritual: forward-only
`migrate()` step, `SCHEMA_VERSION` bump, AND `keeper/api.py`
`SUPPORTED_SCHEMA_VERSIONS` in the SAME commit (test/schema-version.test.ts
enforces). Check `findBridgePreToolUse` (subagent-invocations.ts:258) for the
same miss while there. Preserve: `ORDER BY e.id ASC` total order (re-fold
assignment determinism), COALESCE in SELECT-projection ONLY (never the WHERE),
the LEFT JOIN event_blobs arm. Verify with EQP against the live DB
(`file:$HOME/.local/state/keeper/keeper.db?mode=ro`) before/after.

### Investigation targets

**Required** (read before coding):
- src/subagent-invocations.ts:345-395 — the anti-join + per-row JSON.parse loop
- src/subagent-invocations.ts:240-290 — findBridgePreToolUse (same shape, LIMIT 1)
- src/db.ts:962 area — existing index definitions + the migration-step pattern for adding one
- keeper/api.py:252 — SUPPORTED_SCHEMA_VERSIONS whitelist (same-commit rule)

**Optional** (reference as needed):
- test/subagent-invocations.test.ts — the shard where the determinism case lives

### Risks

A plan flip via ANALYZE alone is fragile (stats drift back) — if (1) works,
still consider (2)/(3) for a stats-independent plan. An index migration on the
2.65GB live DB runs at daemon boot — measure CREATE INDEX time on a copy first
so boot doesn't appear hung.

### Test notes

Refold-determinism test for subagent_invocations (rewind + re-drain, byte-equal)
must pass; add one if the existing shard lacks coverage for the
pending-PreToolUse assignment ordering.

## Acceptance

- [ ] EQP on the live DB shows a session-anchored seek (no hook_event-wide scan) for findPendingPreToolUseForStart
- [ ] `[subagentfold-breakdown]` (from task .1) confirms the SubagentStart avg drops under the 2s bar in a post-fix soak
- [ ] If a schema bump shipped: SCHEMA_VERSION + keeper/api.py updated in the same commit, test/schema-version.test.ts green
- [ ] `bun run test:full` green; refold-determinism byte-identical

## Done summary
Added the v66 session-anchored partial index idx_events_pretooluse_agent_session so the SubagentStart fold's pending-PreToolUse bridge (findPendingPreToolUseForStart/findBridgePreToolUse) seeks one session instead of scanning every PreToolUse row; EQP on the live 2.65GB DB confirms idx_events_hook_event table-wide scan -> session-anchored seek with no temp B-tree. Bumped SCHEMA_VERSION 65->66 and SUPPORTED_SCHEMA_VERSIONS in the same commit, with ANALYZE events on migrate.
## Evidence
