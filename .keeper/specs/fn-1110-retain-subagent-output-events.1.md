## Description

**Size:** S
**Files:** src/compaction.ts, test/compaction.test.ts

### Approach

Move PostToolUse:Agent (currently shed when `subagent_agent_id IS NOT NULL`) and SubagentStop out of the retention shed-class so their bodies survive `retainColdPayloads`. This is a data-capture policy, not a fold requirement: the kept PostToolUse:Agent body carries the subagent's final answer, resolvedModel, and usage; the kept SubagentStop body carries last_assistant_message, effort, and agent_transcript_path — together with the already-kept PreToolUse:Agent prompt they make every subagent's full IO pair durable and SQL-joinable. Update the shed/keep rationale comment block so each class's reason reads true (these two keep for offline-analysis capture, not because a fold reads them). Leave SubagentStart, BackendExecSnapshot, Notification, and all non-Agent tool-body classes shedding exactly as today. No schema change, no migration, no backfill — already-NULLed rows stay NULL; the change only stops future shedding. DB growth is accepted: roughly doubles the kept-body volume (paired outputs at similar size to the ~6.5k kept prompts, ≤26k chars each, over the DB's lifetime).

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/compaction.ts:153-169 — the shed-class SQL allow-list; PostToolUse:Agent at :160-161, SubagentStop in the :166-167 event list
- src/compaction.ts:125-144 — the per-class keep/shed rationale comment block to update
- test/compaction.test.ts — the existing retainColdPayloads shed-class coverage to extend (do not write a parallel suite)

**Optional** (reference as needed):
- src/compaction.ts:89 — RECENT_RETENTION_MARGIN (the last-5000-events gate; unchanged)
- test/refold-equivalence.test.ts — adjacent re-fold coverage; keeping more bodies must not disturb it
- src/daemon.ts:6086 and :426 — the retention pass scheduling (unchanged)

## Acceptance

- [ ] A retention pass over events older than the recency margin leaves PostToolUse:Agent and SubagentStop data bodies intact while non-Agent tool bodies, plan Bash bodies, SubagentStart, BackendExecSnapshot, and Notification bodies still shed
- [ ] The compaction test suite pins the new keep/shed split for both newly-kept classes and at least one still-shed class, and the full fast suite stays green

## Done summary

## Evidence
