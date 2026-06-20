## Description

**Size:** M
**Files:** src/compaction.ts, test/refold-equivalence.test.ts, test/compaction.test.ts, README.md, CLAUDE.md

The determinism-critical core: widen the retention shed-set, couple the data-loss
sentinel to the same predicate, and extend the differential harness to prove the
wider shed is byte-identical-lossless. Online, no migration, no SCHEMA_VERSION bump.

### Approach

Factor TWO exported constants in src/compaction.ts: `RETENTION_SHED_CLASS_PREDICATE`
(CHEAP COLUMNS ONLY — hook_event/tool_name/planctl_op/subagent_agent_id; NO json parse)
= the positive shed-set per the epic Architecture (PostToolUse Write/Edit/MultiEdit/
NotebookEdit/Read/WebFetch/Skill/ToolSearch; PostToolUse Bash WHERE planctl_op IS NULL;
PostToolUse Agent WHERE subagent_agent_id IS NOT NULL; PostToolUseFailure tool bodies
EXCLUDING Agent; PreToolUse tool bodies EXCLUDING Agent; SubagentStart/SubagentStop/
BackendExecSnapshot/Notification). `RETENTION_SHED_PREDICATE` = RETENTION_SHED_CLASS_PREDICATE
AND the existing `NOT(mutation_path IS NULL AND CASE WHEN json_valid(data) THEN
json_extract(data,'$.tool_input.file_path') END IS NOT NULL)` backfill guard — keep the
json_extract scoped so it only ever gates the 4 mutation tools (the other shed classes
have no mutation_path to backfill). Update `countAbsentBlobs` to reuse
RETENTION_SHED_CLASS_PREDICATE inside its `NOT()` (cheap-cols only — it must NOT take the
full predicate's json_extract, which would re-parse a NULLed body). `retainColdPayloads`
needs no body change (the predicate flows through). Write the shed-set as a POSITIVE
allow-list (not NOT(keep-set)) so an unlisted type defaults to KEPT. Update the docs that
enumerate "four mutation tools" (compaction.ts module docblock + RETENTION_SHED_PREDICATE
JSDoc + countAbsentBlobs JSDoc; README ~2604-2644; CLAUDE.md ~42-48) — generalize to the
wider set, keep the mutation_path-promotion qualifier mutation-tool-specific, keep the
"every keep-set body a fold reads stays inline forever" sentence; forward-facing.

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:126 (RETENTION_SHED_PREDICATE), :224-313 (retainColdPayloads + selectBatch embed :257), :343-360 (countAbsentBlobs — the hardcoded 4-tool NOT(), doc :337-341 cheap-cols-only constraint)
- src/reducer.ts:5107-5161 (extractPlanctlStateRepo — planctl Bash state_repo fold-read → Bash keep=planctl_op IS NOT NULL), :4294-4317 (resolveBridgeAgentId — legacy Agent + PostToolUseFailure:Agent agentId fold-read → those keep), :4343-4366 (Cron body read → keep), :3957-4070 (SubagentStart/Stop cheap-col arms), :6857-6907 (Notification/BackendExec cheap-col arms), :7493-7508 (drain SELECT — proves cheap-column hydration)
- src/derivers.ts:159-191 (extractMutationPath — 4-tool gate, proves the backfill guard is mutation-tool-specific)
- test/refold-equivalence.test.ts:93-138 (KEEP_SET_HOOK_EVENTS over-approx — reclassify BackendExecSnapshot/Notification/SubagentStart/SubagentStop to shed), :140-156 (disjointness — import the REAL predicate), :583-600 (shedCorpus hardcoded UPDATE — drive via retainColdPayloads instead), :198-301 (enumeration test — keep green), :311-374 (insertEvent helper)
- test/compaction.test.ts:229/271/317/406/467 (cold-shed/cursor-gate/backfill-guard/sentinel/INCREMENTAL tests); its insertEvent helper does NOT stamp subagent_agent_id/planctl_op — add them for new Agent/Bash shed-class cases
- src/db.ts:50 (SCHEMA_VERSION=74 — do NOT bump), events cols hook_event:367/tool_name:369/subagent_agent_id:389/planctl_op:394 + partial idx :431/:453

### Risks

- HIGHEST: a flipped/loose keep-inversion sheds a fold-read body → silent re-fold break. The three inversions (Bash shed=planctl_op IS NULL; Agent shed=subagent_agent_id IS NOT NULL; PreToolUse:Agent + PostToolUseFailure:Agent KEPT) must be EXACT — the harness corpus must include each guarded pair (kept sibling beside shed sibling) and assert byte-identical re-fold.
- countAbsentBlobs taking the full (json) predicate instead of the cheap class predicate → re-parses NULL bodies / false alarm. Reuse the CLASS predicate only.
- shedCorpus left as the hardcoded UPDATE → the proof tests a fiction (never exercises the widened predicate/cursor/watermark). Drive it through the production path importing the real constant.
- A newly-shed class secretly carrying a top-level session_title/prompt/transcript_path a broad fold reads (audit says none beyond the keep-set classes) — the corpus must include a shed-class row with such a key to prove it's not read.

### Test notes

Extend test/refold-equivalence.test.ts: import the REAL RETENTION_SHED_PREDICATE; drive
the shed via `retainColdPayloads` (recentRetentionMargin:0); assert pre-shed P0 ===
post-shed re-fold P1 === second re-fold P2 AND `countAbsentBlobs(db)===0`, over a corpus
with one row per newly-shed class + the guarded edge cases: planctl Bash (KEEP) beside
non-planctl Bash (SHED) asserting file_attributions(source='planctl') reproduces; modern
Agent (SHED) beside legacy subagent_agent_id IS NULL Agent (KEEP) asserting the bridge
resolves the legacy one; PostToolUseFailure:Agent (KEEP); PreToolUse:Agent (KEEP);
SubagentStart/Stop (assert subagent_invocations row byte-identical after body NULL);
Notification (assert jobs.last_permission_prompt_* stamps from the event_type column);
a Cron row (KEEP — scheduled_tasks reproduces); a malformed shed-class body (safe
default, cursor advances); a shed-while-recent vs shed-after-cold row (cursor/margin
gates). Reclassify KEEP_SET_HOOK_EVENTS + make the disjointness test import the real
constant. Keep the source-enumeration "every body read is pinned" test green (and let it
break loudly if a future fold reads a shed-class body). `bun run test:full` MANDATORY.

## Acceptance

- [ ] RETENTION_SHED_CLASS_PREDICATE (cheap-cols only, positive allow-list) + RETENTION_SHED_PREDICATE (= class AND mutation-tool backfill guard) factored in src/compaction.ts; the three keep-inversions exact (Bash/Agent guards; PreToolUse:Agent + PostToolUseFailure:Agent + Cron kept)
- [ ] countAbsentBlobs reuses RETENTION_SHED_CLASS_PREDICATE (cheap-cols, no json) — no false data-loss alarm on newly-shed bodies
- [ ] refold-equivalence harness imports the REAL predicate, drives via retainColdPayloads, asserts P0===P1===P2 + countAbsentBlobs==0 over every newly-shed class + each guarded edge case; KEEP_SET reclassified; disjointness test imports the real constant; shedCorpus no longer hardcodes the 4-tool UPDATE
- [ ] compaction.test.ts extended (insertEvent stamps subagent_agent_id/planctl_op); docs generalized (compaction.ts/README/CLAUDE.md), forward-facing
- [ ] NO SCHEMA_VERSION bump; `bun run test:full` green

## Done summary

## Evidence
