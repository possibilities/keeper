## Description

**Size:** M
**Files:** test/refold-equivalence.test.ts (new), test/helpers/ (extend), src/reducer.ts (read-only audit)

Build the correctness gate for the whole epic: a test harness proving a from-scratch
re-fold over the live-shaped event log produces byte-identical projection rows whether
the git-attribution scan reads `json_extract($.tool_input.file_path)` (old path) or a
`mutation_path` column (new path), AND that the keep-set allow-list covers every event
whose `data` BODY any live fold reads. This task writes NO production behavior change —
it establishes the proof methodology + baseline that tasks .3 and .4 are gated on.

### Approach

Three layers, cheapest first (per practice-scout): (1) aggregate counts; (2) per-event
extraction audit — for every event, assert the value the fold extracts via the old path
equals the new-path value (this catches a JSON-path mismatch before a full fold);
(3) full differential re-fold — rewind `reducer_state.last_event_id=0`, DELETE the
projections, re-drain, and assert byte-identical row-hashes across ALL projections
(jobs, epics, file_attributions, subagent_invocations, usage, scheduled_tasks,
pending_dispatches, dispatch_failures, autopilot_state, armed_epics, builds, commit
facts). Use the existing rewind-and-rediff harness in test/reducer-projections.test.ts
as the template. Define the keep-set as an explicit ALLOW-list of event types and add a
grep/AST assertion that no fold reads the body of a shed-class event (every
`COALESCE`/`json_extract`/`JSON.parse(...data)`/`SELECT data` reader is enumerated and
classified keep vs shed). Include a legacy-shape charter: legacy Agent
`tool_response.agentId` fallback, malformed payloads (json_valid=false → null), old
Commit/GitSnapshot shapes, the planctl Bash `tool_response.stdout` envelope. Include a
0→v74 from-scratch migrate test asserting the ladder still runs (event_blobs created at
v57, read at v67, dropped only at the v74 tail).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1283-1572 — buildExplicitAttribHoist / findExplicitAttributions; ARM A (toolStmt, json_extract :1292) vs ARM B (relocatedStmt :1294-1305)
- src/reducer.ts:1442-1447 — the "currently-discharged ⇒ safe to drop is FALSE" comment; the re-fold needs since-discharged file_paths, so the new path must read mutation_path for ALL historical mutation rows
- test/reducer-projections.test.ts (e.g. :620, :811, :1505) — rewind+DELETE+re-drain byte-identical harness pattern
- src/subagent-invocations.ts:258,:368 — COALESCE(e.data,b.data) PreToolUse:Agent body reads (allow-list collision — these event types MUST be keep-set)
- src/db.ts:3421-3441 (v67 backfill reads event_blobs), :3211-3214 (v57 CREATE_EVENT_BLOBS), :1485-1508 (needsEventsRebuild offline precedent)

**Optional** (reference as needed):
- test/helpers/template-db.ts (freshDb/freshDbFile), test/helpers/sandbox-env.ts, test/helpers/retry-until.ts
- test/compaction.test.ts:280 — re-fold-over-compacted template

### Risks

- The allow-list is a proof obligation, not a guess — a missed fold-read body silently breaks re-fold after the shed. Enumerate every blob reader in the repo and classify each.
- The harness must run over a live-SHAPED corpus (relocated rows: data IS NULL, value in event_blobs) — a synthetic all-inline fixture would not exercise the ARM B / COALESCE path the shed removes.

### Test notes

This task IS the test. It must be runnable in the fast tier where possible, with the
full-corpus differential variant available for the gate in .3/.4. Poll, don't sleep
(retryUntil) for any async assertions.

## Acceptance

- [ ] Differential re-fold harness asserts byte-identical projection row-hashes (old json_extract path vs new mutation_path-column path) over a live-shaped corpus including relocated rows
- [ ] Per-event extraction audit + legacy-shape charter (legacy agentId, malformed→null, old Commit/GitSnapshot, planctl Bash stdout) pass
- [ ] An explicit keep-set ALLOW-list is defined, and a test enumerates every blob reader and asserts no fold reads a shed-class event body
- [ ] A 0→v74 from-scratch migrate test passes (ladder steps creating/reading event_blobs intact; DROP only at v74 tail)
- [ ] `bun run test:full` green

## Done summary

## Evidence
