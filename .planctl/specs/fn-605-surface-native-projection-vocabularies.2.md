## Description

**Size:** M
**Files:** `src/reducer.ts`, `src/types.ts`, `src/subagent-invocations.ts`, `README.md`, `test/reducer.test.ts`, `test/subagent-invocations.test.ts`, `test/fixtures/subagent_invocation_cases.jsonl`, `scripts/generate-subagent-invocation-fixtures.py`

### Approach

Widen `subagent_invocations.status` from the 4-value defined-but-only-2-written enum (`running|ok|failed|unknown`) to a 5-value fully-populated enum (`running|ok|failed|unknown|superseded`). Three new reducer write paths:

1. **`PostToolUseFailure` with `tool_name='Agent'`** — currently a no-op at `src/reducer.ts:971`. Resolve the bridge `agent_id` from `event.subagent_agent_id` (the same field PostToolUse:Agent reads), then UPDATE the matching row to `status='failed'`. Mirror the existing PostToolUse:Agent arm's lookup pattern. No `tool_response` is needed — the `subagent_agent_id` is enough. Orphan failures (no matching row) are a safe no-op, mirroring SubagentStop's orphan-stop branch at `reducer.ts:852-854`.

2. **Job-lifecycle terminal sweep → `unknown`** — when the reducer folds a SessionEnd or Killed event for a job, run a bulk `UPDATE subagent_invocations SET status='unknown', last_event_id=?, updated_at=? WHERE job_id=? AND status='running'` in the same transaction. Bulk UPDATE not per-row loop (never throw in fold). This closes orphaned subs whose parent session died.

3. **`SubagentStart` → mark prior open same-type as `superseded`** — **run this scan in the PostToolUse:Agent arm**, not at SubagentStart. The Q1 decision: `subagent_type` is often NULL at SubagentStart time (the FIFO bridge seedType comes from `event.agent_type` which may be absent); PostToolUse:Agent is the moment `subagent_type` becomes authoritative (PreToolUse-wins precedence). After resolving the bridge and confirming `subagent_type`, scan for OTHER rows: same `job_id`, same now-known `subagent_type`, `status='running'`, `ts < current row's ts`. UPDATE all matches to `status='superseded'` in the same transaction. Add a `findOpenRunningInGroup(jobId, subagentType, currentTs)` helper in `src/subagent-invocations.ts:111-158` (mirror the existing `findOpenTurnForStop` style).

**Terminal-status guard widening**: the guards at `reducer.ts:876,948` already protect `failed`/`unknown` — extend to also protect `superseded`:

```typescript
const nextStatus =
  row.status === "failed" || row.status === "unknown" || row.status === "superseded"
    ? row.status
    : "ok";
```

Otherwise a late SubagentStop or PostToolUse:Agent could flip `superseded` → `ok`, which is semantically wrong.

**Type widening**: `SubagentInvocation.status` at `src/types.ts:326` and `CanonicalRow.status` at `src/subagent-invocations.ts:91` both gain `"superseded"`. No CHECK constraint on the SQL column (per practice-scout), so no SQL migration needed for the column type.

**Golden fixture regen**: `test/fixtures/subagent_invocation_cases.jsonl` needs regen via `scripts/generate-subagent-invocation-fixtures.py` with new cases exercising each new arm (PostToolUseFailure→failed, SessionEnd-sweep→unknown, SubagentStart-then-supersede→superseded).

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:789-983` — `projectSubagentInvocationsRow`; four existing arms (SubagentStart 794-844, SubagentStop 846-884, PostToolUse 886-969, PostToolUseFailure 971-979)
- `src/reducer.ts:876,948` — terminal-status guard (must include `superseded`)
- `src/reducer.ts` job-lifecycle terminal arms (SessionEnd, Killed) — add subagent sweep in same transaction
- `src/types.ts:300-330` — `SubagentInvocation` shape; `status` union widen
- `src/subagent-invocations.ts:86-96` — `CanonicalRow.status` golden-fixture parity type
- `src/subagent-invocations.ts:111-158` — `extractTurnSeq` + `findOpenTurnForStop`; add `findOpenRunningInGroup` helper
- `test/subagent-invocations.test.ts:430,438` — golden-fixture parity test (will need fixture regen)
- `scripts/generate-subagent-invocation-fixtures.py` — fixture generator

**Optional** (reference as needed):
- Real DB census: `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT status, count(*) FROM subagent_invocations GROUP BY status;"` to see live distribution; supersession case visible at session `1b0b35e0` (9 rows of one subagent_type, 4 stale running entries from a single re-entrant agent_id)

### Risks

- **Superseded must be in the terminal guard** — otherwise SubagentStop or late PostToolUse:Agent would flip a superseded row back to `ok`. Test: insert a superseded row, then fold a SubagentStop, assert status stays `superseded`.
- **Bulk UPDATE in the terminal sweep must use `db.run()` not a prepared statement cache** — Bun statement cache gotcha at `db.ts:755-763`. If the sweep targets a freshly-ALTERed column shape, use uncached `db.run()`.
- **Parallel same-type spawns false-positive (known limitation)**: when the parent fires two concurrent `Task(subagent_type=X)` calls in one message, (a)'s supersession rule would mark the older one's `[running]` as `[superseded]` the moment the newer one's PostToolUse:Agent lands. This is the same false-positive the renderer's existing `is_replaced` rule already has. Document as known limitation; out of scope here.
- **PostToolUseFailure orphan (no matching SubagentStart row)** — define as safe no-op, mirroring SubagentStop's orphan-stop branch.

### Test notes

- Reducer tests in `test/reducer.test.ts`: one case per new arm (PostToolUseFailure→failed, SessionEnd-sweep→unknown, SubagentStart-then-supersede→superseded); terminal-guard cases for all three terminal values (including superseded).
- Golden-fixture parity regression in `test/subagent-invocations.test.ts`: regen fixtures, assert `canonicalizeRow` output matches Python reference for the new arms.
- Re-fold determinism test: re-fold the new arms from cursor 0, assert byte-identical projection.

## Acceptance

- [ ] `PostToolUseFailure[tool_name='Agent']` UPDATEs the matching `subagent_invocations` row to `status='failed'`; orphan failures (no matching row) are a safe no-op
- [ ] SessionEnd and Killed folds sweep open `status='running'` subs for the job to `status='unknown'` in the same transaction
- [ ] PostToolUse:Agent arm marks prior same-`(job_id, subagent_type)` open `running` rows with earlier `ts` as `status='superseded'`
- [ ] Terminal-status guard at `reducer.ts:876,948` includes `superseded` alongside `failed`/`unknown`
- [ ] `SubagentInvocation.status` and `CanonicalRow.status` union widened to 5 values; all exhaustive switches over the type compile
- [ ] Golden fixtures regenerated; parity test passes for all new arms
- [ ] Re-fold from cursor 0 produces byte-identical `subagent_invocations` rows
- [ ] `README.md` vocabulary updates at lines 67-70 and 440-442 list all 5 values

## Done summary

## Evidence
