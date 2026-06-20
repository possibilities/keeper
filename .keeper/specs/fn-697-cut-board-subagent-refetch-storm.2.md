## Description

**Size:** M
**Files:** src/collections.ts, test/board.test.ts, test/readiness-client.test.ts, src/readiness-client.ts (comments)

Lever 2 (load-bearing — serialize is the dominant cost). The
subagent_invocations descriptor selects 12 columns (~665KB/frame), but
readiness + render + the autopilot read only 7. Narrow the descriptor to
the safe-7 to ~halve every refetch's serialize cost. Wire + in-process
only — no SCHEMA_VERSION bump, no keeper-py touch.

### Approach

Narrow `SUBAGENT_INVOCATIONS_DESCRIPTOR.columns`
(`src/collections.ts:539-562`) from 12 to the safe-7:
`{job_id, subagent_type, turn_seq, ts, status, description, last_event_id}`
(dropping `agent_id, tool_use_id, prompt_chars, duration_ms, updated_at`).
`last_event_id` MUST stay — it's the version column the diff
(`selectVersionsByIds`) and the result re-seed read. Then AUDIT every
consumer of `descriptor.columns` to confirm none reads a dropped column:
(1) wire render — `collapseSubagentsByName` (readiness-client.ts:505-538)
+ `subagentLinesFor` (board-render.ts:416-442) read
`{job_id, subagent_type, turn_seq, status, description}` and need ALL rows
per (job,type) incl non-running/superseded for ×N/stuck; (2) predicate-6
(readiness.ts:560-595) reads `{job_id, status, ts}`; (3) the IN-PROCESS
autopilot read (autopilot-worker.ts:1213-1230 → collapseSubagentsByName).
`countAndToken` reads only pk (`group_concat`) and `selectVersionsByIds`
reads `(pk, version)` — both unaffected. Confirm `jsonColumns` is empty for
this descriptor (all 7 are scalars, no decode change). NOT a row-filter or
page (those break render's count/stuck + the byId diff). Update the
`SUBAGENT_INVOCATIONS_PAGE_LIMIT = 0` comment (readiness-client.ts:116) and
verify the `state.rows`-not-`byId` invariant block (:45-51) still reads
true (same rows, fewer columns — likely no edit).

### Investigation targets

**Required** (read before coding):
- src/collections.ts:539-562 — SUBAGENT_INVOCATIONS_DESCRIPTOR (columns to narrow; pk, version, sortable, filters)
- src/readiness.ts:376-390, :560-595 — predicate-6 read-set ({job_id, status, ts})
- src/readiness-client.ts:505-538 — collapseSubagentsByName read-set (+ superseded/stuck logic reads non-running rows)
- src/board-render.ts:416-442 — subagentLinesFor render read-set + ×N/stuck annotations
- src/autopilot-worker.ts:1213-1230 — the in-process runQuery consumer of descriptor.columns (a SECOND consumer, not just the wire)
- src/collections.ts:1026-1046 — countAndToken (pk-only; confirm unaffected)
- test/board.test.ts:149-172, :186+ — projectRows + collapseSubagentsByName ×N/stuck invariants (must stay green)

**Optional** (reference as needed):
- src/protocol.ts:121-138 — QueryFrame.limit (board still sends limit:0; no change)
- src/collections.ts:811-894 — selectByIds / selectVersionsByIds (version-probe reads (pk,version) only)

### Risks

- A consumer reading a dropped column gets `undefined` SILENTLY (blank pill, no error) — the cross-consumer audit is load-bearing, not optional.
- The autopilot in-process read makes this NOT "wire-only" — if a future autopilot read needs a dropped col it breaks quietly; assert the safe-7 satisfies all three consumers.
- If any dropped column turns out to be needed, keep it (re-narrow to the minimal safe set) rather than forcing the 7.

### Test notes

test/board.test.ts (projectRows full-row/wire-order + collapseSubagentsByName
×N/stuck/different-types) must stay green with the narrowed columns; add an
assertion that the safe-7 still feed collapse losslessly. bench-latency
before/after: subagent frame bytes ~halve. No schema-version test impact
(wire-only).

## Acceptance

- [ ] descriptor narrowed to the safe-7 `{job_id, subagent_type, turn_seq, ts, status, description, last_event_id}`
- [ ] every descriptor consumer audited — wire render (collapse + subagentLinesFor ×N/stuck), predicate-6, in-process autopilot — confirmed to read only kept columns
- [ ] countAndToken / selectVersionsByIds confirmed unaffected (pk + version only); no SCHEMA_VERSION bump, no keeper-py change
- [ ] test/board.test.ts + test/readiness-client.test.ts green; PAGE_LIMIT comment + invariant-block prose verified/updated
- [ ] bench-latency shows reduced subagent frame size / board surfacing latency (record in Evidence)

## Done summary
Narrowed SUBAGENT_INVOCATIONS_DESCRIPTOR.columns from 12 to the safe-7 {job_id, subagent_type, turn_seq, ts, status, description, last_event_id}. Audited all consumers (wire collapse + subagentLinesFor, predicate-6, in-process autopilot read, countAndToken pk-only, selectVersionsByIds pk+version) read only kept columns. Bench: ~39% smaller subagent refetch frame (833KB to 507KB at 2005 rows, ~6.7MB saved per 21-subscriber fold burst). No SCHEMA_VERSION/keeper-py change.
## Evidence
