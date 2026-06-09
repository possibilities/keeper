## Description

**Size:** S
**Files:** src/subagent-invocations.ts, src/reducer.ts, test/subagent-invocations.test.ts

### Approach

Add `LEFT JOIN event_blobs b ON b.event_id = e.id` + `COALESCE(e.data, b.data) AS
data` to the ONLY two raw fold-path blob reads: findBridgePreToolUse
(src/subagent-invocations.ts:248-257) and findPendingPreToolUseForStart
(:351-366). Template: loadCommitTrailerInvocations (src/reducer.ts:5687-5697).
The COALESCE goes in the SELECT projection only — both functions filter on indexed
scalar columns (tool_use_id; session_id/tool_name/hook_event) which the relocator
NEVER nulls, so the WHERE clauses stay byte-identical (wrapping them would break
index use). Keep the existing never-throw JSON.parse guards (:265-267, :629).

The audit is already done — encode it: rewrite the false claim at
src/reducer.ts:1602-1609 ("the ONE reducer read of the blob VALUE that is NOT a
plain COALESCE") into an accurate enumeration: the two-arm mutation-discharge scan
(deliberate, index-preserving — do NOT convert to COALESCE), the now-fixed bridge
reads, the drain SELECT + two Commit-trailer reads (already COALESCE), scalar-only
reads (no blob), and migration/compaction-internal reads (exempt: db.ts
4278/4687/5161/5400/5919 run inside migrate(); compaction.ts 209/216/288 are the
relocator itself — countAbsentBlobs deliberately avoids materializing blobs).
Also add a short event_blobs read-contract paragraph to README Architecture
(every fold-path blob read COALESCEs or documents why not).

### Investigation targets

**Required** (read before coding):
- src/subagent-invocations.ts:248-257, 351-366 — the two reads
- src/reducer.ts:5687-5697 — the COALESCE template; :1602-1682 — the deliberate two-arm split (leave alone)
- src/compaction.ts:101, 188-230 — relocator semantics (NULLs data only, RECENT_RETENTION_MARGIN is pacing not correctness)
- test/subagent-invocations.test.ts:39-118, 244, 553 — insert/call shapes; test/compaction.test.ts:24-27, 234, 271 — compactColdBlobs({recentRetentionMargin:0}) + COALESCE assertion shape

### Risks

- Do not touch the two-arm scan or countAbsentBlobs — both are deliberate non-COALESCE designs with documented rationale.

### Test notes

Relocate-then-assert: insert PreToolUse:Agent (+ Start/Stop lifecycle) events, run
compactColdBlobs(db, {recentRetentionMargin: 0}) so events.data goes NULL, then
(a) assert both functions still resolve the bridge; (b) golden re-fold: fold the
stream pre-relocation, snapshot subagent_invocations rows, re-fold from scratch
post-relocation, assert byte-identical rows (including the supersession/Stop-guard
outcomes the bridge feeds).

## Acceptance

- [ ] both reads COALESCE via LEFT JOIN; WHERE clauses unchanged; never-throw guards intact
- [ ] forced-relocation tests pass: bridge resolves + byte-identical re-fold of subagent rows
- [ ] reducer.ts enumeration comment accurate; README event_blobs read-contract paragraph added
- [ ] full bun test green; no schema bump

## Done summary
COALESCE'd both subagent bridge blob reads (findBridgePreToolUse, findPendingPreToolUseForStart) over LEFT JOIN event_blobs so relocated PreToolUse:Agent blobs re-fold byte-identically; rewrote the false 'ONE non-COALESCE read' claim into an accurate per-site enumeration and added a README event_blobs read-contract paragraph, with relocate-then-assert tests proving the bridge resolves and the re-fold is byte-identical.
## Evidence
