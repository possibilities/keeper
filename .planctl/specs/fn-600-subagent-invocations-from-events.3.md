## Description

**Size:** M
**Files:** src/reducer.ts, src/collections.ts, test/reducer.test.ts (extend), test/collections.test.ts (extend if exists)

### Approach

Wire the parser-port from task .2 into keeper's per-event reducer and expose the projection as a wire-served collection. All reducer writes ride inside the same `BEGIN IMMEDIATE` as the cursor advance — non-negotiable per keeper's exactly-once invariant.

**Reducer fold arms** in `src/reducer.ts` — dispatched from `projectJobsRow`'s switch (or via a sibling `projectSubagentInvocationsRow` helper called inside the same `BEGIN IMMEDIATE`):

- `SubagentStart` — call `extractTurnSeq(db, jobId, agentId)`; INSERT row with `status='running'`, `duration_ms=NULL`, `subagent_type` seeded from `event.agent_type` (null when absent — PreToolUse-wins precedence applies later), `tool_use_id=NULL`, `description=NULL`, `prompt_chars=0`, `last_event_id=event.id`, `updated_at=event.ts`. NULL `agent_id` → safe no-op (cursor still advances).
- `SubagentStop` — call `findOpenTurnForStop(db, jobId, agentId)`; UPDATE that row's `duration_ms = round((event.ts - row.ts) * 1000)` (events.ts is REAL seconds; duration_ms is integer ms — matches Python's `int(float(ts_raw) * 1000)` convention); set `status='ok'` unless already 'failed'/'unknown'; bump `last_event_id` + `updated_at`. No open turn → safe no-op.
- `PreToolUse` with `tool_name='Agent'` — no row written; the PreToolUse row itself lives durably in `events` and gets read at PostToolUse fold time via `findBridgePreToolUse`.
- `PostToolUse` with `tool_name='Agent'` — call `resolveBridgeAgentId(event)`; if null, safe no-op. Look up turn-0 row in `subagent_invocations` by `(job_id=event.session_id, agent_id=bridge, turn_seq=0)`; if absent, safe no-op. Otherwise call `findBridgePreToolUse(db, event.session_id, event.tool_use_id)` and UPDATE the turn-0 row with `tool_use_id`, `description` (truncated via `truncateDescription`), `prompt_chars`, and `subagent_type` (PreToolUse-wins precedence: overwrite only when PreToolUse value is non-empty, mirroring Python's `if subagent_type:` truthiness as `typeof v === "string" && v.length > 0`). Set `status='ok'` unless already terminal; bump `last_event_id` + `updated_at`.
- `PostToolUseFailure` with `tool_name='Agent'` — Python contract: no bridge resolvable. Safe no-op; lifecycle correctness rests on SubagentStop landing 'ok'.

The default-arm comment at `src/reducer.ts:1135` ("SubagentStart, SubagentStop, and any unknown forward-compat event") loses the SubagentStart / SubagentStop enumeration — those are now handled cases. The comment should still cover unknown forward-compat events as a safe no-op.

`drain()`'s SELECT projection at `src/reducer.ts:1248-1272` already includes `tool_use_id` and `subagent_agent_id` (task .1 added the former). No additional projection columns needed.

**Collection descriptor** in `src/collections.ts`: register `SUBAGENT_INVOCATIONS_DESCRIPTOR` in `REGISTRY` with:
- `name: "subagent_invocations"`
- `table: "subagent_invocations"`
- `pk: ["job_id", "agent_id", "turn_seq"]`
- `version: "last_event_id"`
- `filters: ["job_id"]`
- `sortable: ["ts", "turn_seq", "duration_ms"]`
- `defaultSort: { col: "ts", dir: "ASC" }`
- No `defaultFilter` (subscribe returns all per-job rows by default; clients can filter by `status` etc. via the descriptor's exposed columns)

Defaults follow `JOBS_DESCRIPTOR`'s shape (`src/collections.ts:80-134`).

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:905-1183` — `projectJobsRow` switch where the new cases land (or where a sibling helper is called inside `applyEvent`'s tx).
- `src/reducer.ts:1131-1140` — current default arm listing SubagentStart/SubagentStop as known no-ops; this comment is the seam.
- `src/reducer.ts:1196-1232` — `applyEvent` showing the `BEGIN IMMEDIATE` envelope; new writes ride inside the same transaction.
- `src/reducer.ts:1248-1272` — `drain()`'s SELECT projection; verify `tool_use_id` and `subagent_agent_id` are both projected (task .1 added tool_use_id).
- `src/reducer.ts:724-858` — `syncJobIntoEpic` for the cross-table fan-out pattern (peer-table writes are simpler — just INSERT/UPDATE — but the "inside the same BEGIN IMMEDIATE" invariant is the same).
- `src/collections.ts:80-134` — `JOBS_DESCRIPTOR` template.
- `src/collections.ts:226-235` — `REGISTRY` registration.
- `src/collections.ts:246-308` — generic `selectByIds` / `decodeRow` (used by any collection without modification).
- `src/subagent-invocations.ts` (from task .2) — the helpers this task calls.
- `test/reducer.test.ts:14-86` — fresh-DB test pattern.

**Optional** (reference as needed):
- `src/reducer.ts:359-516` — `projectPlanRow` as another non-jobs projection pattern.
- `/Users/mike/code/arthack/apps/cli_common/cli_common/subagent_invocations.py:483-645` — Python `_process_row` for line-by-line semantic parity check.

### Risks

- **Bridge lookup performance.** `findBridgePreToolUse` lands `idx_events_tool_use_id` (task .1 partial index) via SQLite Rule 2: query `WHERE tool_use_id = ?` matches index `WHERE tool_use_id IS NOT NULL`. The additional WHERE clauses (`session_id`, `hook_event`, `tool_name`) refine row selection. Verify with `EXPLAIN QUERY PLAN` on a populated DB that the partial index is used.
- **PostToolUse-before-SubagentStop ordering** (Anthropic-confirmed for Task tool calls). `SubagentStop` UPDATE gates on `duration_ms IS NULL` ALONE; the `post-before-stop` fixture from task .2 covers this. Verify the reducer's `findOpenTurnForStop` call matches the helper's SQL gate exactly.
- **Cross-job contamination.** Bridge lookup MUST include `session_id` in WHERE. A subagent in one session and an unrelated subagent in another session can collide on tool_use_id. Verify against task .2's `cross-job-tool-use-id-collision` fixture.
- **Never-throw invariant.** Every reducer arm wraps `JSON.parse` and any helper that could throw in try/catch returning safe defaults. A bad `data.tool_response` JSON blob folds to "drop" not "throw" — add a malformed-data unit test to enforce.
- **Re-fold determinism on subagent_type seed.** SubagentStart INSERT seeds `subagent_type` from `event.agent_type`. PostToolUse:Agent overwrites IFF PreToolUse value is non-empty (Python's `if subagent_type:` truthiness). Empty-string PreToolUse value must NOT overwrite a non-null seed. Test with a fixture entry that has empty `tool_input.subagent_type` on PreToolUse.
- **PostToolUse:Agent landing without a turn-0 row** (theoretical PostToolUse-before-SubagentStart ordering). Drop with safe no-op; lose description/prompt_chars for that turn. Matches Python's behavior; the SubagentStop-side `status='ok'` later still lands.

### Test notes

- `test/reducer.test.ts`: per-arm tests — SubagentStart writes a row; SubagentStop closes the latest open turn; PostToolUse:Agent folds metadata; PostToolUseFailure:Agent is a no-op; orphan SubagentStop is a no-op; PostToolUse-before-SubagentStop ordering closes correctly; malformed `data.tool_response` JSON folds to safe no-op (no throw).
- Re-fold determinism test: seed events, drain, capture rows, rewind cursor + DELETE FROM subagent_invocations + drain, assert byte-identical.
- Coexistence with fn-598: session with both planctl invocations and Agent calls populates both projections; both deterministic on re-fold.
- Collection wire test: subscribe to `subagent_invocations` filtered by `job_id`, fold a SubagentStart, assert the patch frame arrives with `status='running'`; fold the SubagentStop, assert the patch updates `status`/`duration_ms`/`last_event_id`.

## Acceptance

- [ ] `src/reducer.ts` adds switch arms (or dispatches to a sibling projection function) for `SubagentStart`, `SubagentStop`, `PostToolUse` (`tool_name='Agent'`), and `PostToolUseFailure` (`tool_name='Agent'`). The default-arm comment at line ~1135 no longer enumerates these as no-ops.
- [ ] All four arms call helpers from `src/subagent-invocations.ts` (task .2) — no parser logic duplicated in the reducer.
- [ ] All reducer writes ride inside the same `BEGIN IMMEDIATE` as the cursor advance. No new transaction boundaries.
- [ ] `src/collections.ts` registers `SUBAGENT_INVOCATIONS_DESCRIPTOR` in `REGISTRY`. Filterable by `job_id`; pk `(job_id, agent_id, turn_seq)`; version column `last_event_id`; default sort `ts ASC`.
- [ ] Re-fold determinism: rewind cursor + `DELETE FROM subagent_invocations` + drain reproduces byte-identical rows.
- [ ] Orphan SubagentStop, orphan PostToolUseFailure, and any malformed event fold to safe no-ops — cursor advances, no row mutation, no throw.
- [ ] PostToolUse:Agent fold preserves PreToolUse-wins `subagent_type` precedence (matches Python's truthiness check).
- [ ] Coexistence with fn-598: a test session with both planctl invocations and Agent calls populates both projections; both deterministic on re-fold.
- [ ] Wire subscribe to `subagent_invocations` filtered by `job_id` returns the per-job timeline and emits patch frames as rows transition `running → ok`.
- [ ] `bun test test/reducer.test.ts` (and `test/collections.test.ts` if extant) passes.

## Done summary

## Evidence
