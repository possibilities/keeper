## Overview

Post-fn-836, keeper's retention pass (src/compaction.ts) NULLs cold inline bodies of
ONLY the 4 PostToolUse mutation tools. A panel-vetted, audit-backed, scout-verified
analysis found ~683 MB / ~614k more rows across ~10 event classes are NEVER fold-read
and safe to shed by WIDENING the retention predicate. This is a pure predicate
widening — no migration, no DROP, no SCHEMA_VERSION bump (event_blobs is already gone,
bodies are inline, auto_vacuum=INCREMENTAL is baked). End state: DB 1.3 GB → ~0.6 GB,
growth bounded further, re-fold determinism preserved.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT printf('%.0f MB', SUM(LENGTH(data))/1e6) FROM events WHERE data IS NOT NULL"` — inline-body footprint (drops toward ~200 MB as the shed drains)
- `bun test test/refold-equivalence.test.ts test/compaction.test.ts` — the determinism + retention gates
- `bun run test:full` — MANDATORY before landing (db/compaction/fold paths)
- `ls -lh ~/.local/state/keeper/keeper.db` — file size (shrinks only after the .2 offline VACUUM)

## Acceptance

- [ ] Retention sheds the widened class-set (cold, past-cursor) and re-fold stays byte-identical — proven by the differential harness importing the REAL predicate
- [ ] `countAbsentBlobs` reuses the shared class predicate (no false data-loss alarm on newly-shed bodies)
- [ ] DB file reclaimed to ~0.6 GB after the catch-up drain + offline VACUUM; auto_vacuum=INCREMENTAL re-asserted
- [ ] No SCHEMA_VERSION bump; `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (the differential harness, importing the production predicate, asserting pre-shed P0 === post-shed re-fold P1 === P2 + countAbsentBlobs==0 over every newly-shed class + the guarded edge cases). If it can't show byte-identical re-fold for a class, that class is mis-classified — fix the predicate before widening further.

## References

- Panel verdict (opus4.8-gpt5.5) + exhaustive fold-read audit: the exact shed-set + the determinism caveats.
- Follows fn-836 (event_blobs shed + retention pass), DONE/CLOSED — satisfied prerequisite. epic-scout: zero open-epic deps or overlaps (no open epic touches src/compaction.ts / the retention tests / src/backup.ts).

## Architecture

Two shared constants in src/compaction.ts: RETENTION_SHED_CLASS_PREDICATE (CHEAP COLUMNS
ONLY — hook_event/tool_name/planctl_op/subagent_agent_id; NO json parse) is the positive
shed-set (an explicit allow-list of classes-to-shed; a new/unlisted event type defaults
to KEPT — fail-safe). RETENTION_SHED_PREDICATE = RETENTION_SHED_CLASS_PREDICATE AND the
existing mutation-tool backfill guard (the lone json_extract, which only ever bites the 4
mutation tools). `countAbsentBlobs` (the data-loss sentinel) reuses the CHEAP class
predicate inside its NOT() — it must never re-parse a NULLed body. The shed-set:
  - PostToolUse: Write/Edit/MultiEdit/NotebookEdit, Read, WebFetch, Skill, ToolSearch
  - PostToolUse Bash WHERE planctl_op IS NULL   (planctl rows keep — state_repo is fold-read)
  - PostToolUse Agent WHERE subagent_agent_id IS NOT NULL   (legacy NULL-id rows keep — agentId fold-read)
  - PostToolUseFailure tool bodies EXCLUDING Agent (its legacy agentId is fold-read)
  - PreToolUse tool bodies EXCLUDING Agent (the subagent bridge reads PreToolUse:Agent)
  - SubagentStart, SubagentStop, BackendExecSnapshot, Notification (folds read only columns)
KEPT (by omission or guard): GitSnapshot, Commit, UserPromptSubmit, Stop, Usage/Task/
EpicSnapshot, WindowIndexSnapshot, Cron*/Monitor/SendMessage/TaskUpdate, the synthetic
autopilot/dispatch events, PreToolUse:Agent, planctl Bash, legacy Agent.

## Rollout

Two landings, in order (predicate proof FIRST, then the operational reclaim — per the
panel: keep them separate so a projection divergence is isolable):
1. `.1` lands the widened predicate + couplings + proof + docs (online, worker). After it
   lands, restart the daemon so the retention pass loads the widened predicate.
2. `.2` is the operator-driven catch-up + offline VACUUM (the steady-state timer would
   take 5+ hours and the file won't shrink without a full VACUUM): drain the batched pass
   to completion (elevated maxBatches, ≤500 rows/tx — NEVER a single giant UPDATE), then
   PAUSE autopilot → STOP daemon → reclaimDb (VACUUM INTO + auto_vacuum=INCREMENTAL bake +
   quick_check) → atomic swap + clear stale -wal/-shm → restart → keeper await server-up →
   verify DB ~0.6 GB + auto_vacuum=2 + re-fold byte-identical. Rollback: the VACUUM-INTO
   output leaves the live file untouched until the swap; keep a pre-reclaim snapshot.
