## Description

**Size:** S
**Files:** src/db.ts, src/server-worker.ts, test/db.test.ts

### Approach

Three bounded cleanups: (1) server-worker's writer connection re-runs the full
63-slot migration ladder on every spawn — pass the migrate-disable option at
src/server-worker.ts:2709 (options interface src/db.ts:1829-1832; main is the
sole migrator per CLAUDE.md). (2) Bound the every-boot ANALYZE at
src/db.ts:4430-4432: set `PRAGMA analysis_limit` (~400) before it (or switch to
`PRAGMA optimize`) — the justifying comment assumes ~110k events rows; the table
is 624k+. The three version-gated ANALYZE sites (:3118, :3224, :3610) run once
historically — leave them. ANALYZE only writes sqlite_stat1 — re-fold safe.
(3) Drop dead events indexes via `DROP INDEX IF EXISTS` in the migrate tail
(exemplar :4874-4875, no version bump — index choice never changes fold output):
idx_events_event_type (:529) and idx_events_tool_name (:530) are grep-verified
consumer-less; idx_events_hook_tool (:538) is prefix-subsumed by
idx_events_hook_tool_ts (:544) — EXPLAIN-verify findInferredAttributions picks
the _ts variant. idx_events_hook_event (:528) HAS named consumers
(reducer.ts:5718/5790 Commit scans, subagent-invocations.ts:372): drop it ONLY
if EXPLAIN QUERY PLAN shows the composite's leading column serves them with no
SCAN regression; otherwise keep it and note why. Update the required-index array
in test/db.test.ts:83-104 in the SAME commit (it lists all four), and use the
covering-scan test shape (:111+) to assert the surviving index serves the
hook_event-only consumers.

### Investigation targets

**Required** (read before coding):
- src/db.ts:526-544 — the index DDLs; :4421-4432 — boot ANALYZE; :4874-4875 — drop exemplar
- src/server-worker.ts:2708-2709 — the two openDb calls
- test/db.test.ts:77-109 — the index array that must change in lockstep; :111+ — covering-scan assertion model

### Risks

- idx_events_hook_event is the only conditional drop — EXPLAIN proof or keep.
- No SCHEMA_VERSION bump anywhere (schema-version test must stay untouched).

### Test notes

bun test test/db.test.ts + full suite; EXPLAIN QUERY PLAN snippets for the
hook_event consumers go in the task Evidence.

## Acceptance

- [ ] server-worker spawn no longer migrates; boot ANALYZE bounded
- [ ] consumer-less indexes dropped with the test array updated same-commit; hook_event drop only with EXPLAIN proof (else documented keep)
- [ ] full bun test green; no schema bump

## Done summary

## Evidence
