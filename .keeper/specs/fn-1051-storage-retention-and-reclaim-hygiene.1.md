## Description

**Size:** S
**Files:** src/compaction.ts, src/derivers.ts, src/backfill-mutation-path.ts, test/compaction.test.ts, README.md

### Approach

Lift the four-mutation-tool SQL fragment into dep-free src/derivers.ts (the canonical home of `extractMutationPath` — do NOT export from the backfill module, and do NOT pull `GUARDED_EXTRACT` along; compaction has its own json_valid CASE) and have both src/backfill-mutation-path.ts:97-98 and the shed guard consume it. The fix itself is one clause: the guard inside `RETENTION_SHED_PREDICATE` (src/compaction.ts:226-233) gains the four-tool scope so it reads "a row still owing a mutation_path backfill" = PostToolUse × {Write,Edit,MultiEdit,NotebookEdit} × mutation_path IS NULL × file_path present. `RETENTION_SHED_CLASS_PREDICATE` stays byte-identical (the widened class is intentional), so `countAbsentBlobs` (compaction.ts:817) is untouched — assert that in review. The steady-state `retainColdPayloads` pass drains the ~54k-row backlog on its own; no one-shot sweep, no schema bump. scripts/reclaim-db.ts's `drainColdPayloads` inherits the corrected predicate automatically (intended, idempotent).

Reconcile the README compaction prose (~3984-4052) to describe the corrected allow-list directly (collapse the historical-widening narrative per docs rule #0) and prune the completed one-time catch-up runbook (~4305-4328).

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:200-240 — the predicate constants and the guard clause
- src/derivers.ts:204-226 — extractMutationPath, the source of truth the guard must mirror
- test/compaction.test.ts:322-383 — the existing guard-pinning test that must stay green
- test/compaction.test.ts:385+ — the retention-then-refold byte-identical proof and its seedStream

**Optional** (reference as needed):
- src/backfill-mutation-path.ts:90-110 — MUTATION_TOOL_PREDICATE and its unaliased column context

### Risks

- The guard and extractMutationPath drifting again — deriving both from one exported constant is the point of the lift
- The re-fold proof not covering the newly-shed rows — seeding is part of this task, not optional

### Test notes

Red-first: "a PostToolUse:Read row carrying tool_input.file_path SHEDS" fails on current source. Keep :322-383 green (Write row owing backfill stays inline). Seed the :385 re-fold stream with a Read-with-file_path row so the byte-identical proof covers the class this fix newly sheds.

## Acceptance

- [ ] Guard scoped to the four mutation tools via one shared dep-free constant; class predicate and sentinel byte-unchanged
- [ ] Read-shed assertion red-first then green; guard-pinning test green; re-fold proof covers the new class
- [ ] README compaction prose reconciled; stale runbook pruned; full fast suite green

## Done summary
Scoped the compaction shed guard to the four mutation tools via a shared dep-free MUTATION_TOOL_SQL_PREDICATE in src/derivers.ts (consumed by both the historical backfill and the retention shed guard), so Read/WebFetch/Skill/ToolSearch bodies carrying tool_input.file_path now shed instead of being pinned inline forever. Class predicate and data-loss sentinel byte-unchanged; added a red-first Read-shed assertion and extended the re-fold-equivalence stream to cover the newly-shed class; reconciled README compaction prose and pruned the completed fn-837.2 catch-up runbook.
## Evidence
