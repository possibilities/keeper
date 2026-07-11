## Description

**Size:** S
**Files:** (read-only spike — findings land under ~/docs, no repo writes)

### Approach

Measure which conflict class dominates keeper's history BEFORE the rest of this epic
builds file-overlap machinery. Read-only over keeper.db (the daemon is sole writer —
open read-only) plus git history: collect every historical DispatchFailed event whose
reason carries a worktree merge-conflict token, and classify each incident: (a)
sibling file-overlap — work-verb fan-in (rib into a dependent lane) and close-sink
(leaf into base) conflicts where the two sides' landed per-task file sets intersect
(reconstruct per-task actuals from Commit event files[] via Task: trailers); (b)
base-drift — recover-pass and finalize base-into-default conflicts; (c) other —
rename/semantic/unattributable. Write a findings doc with per-class counts and
exemplars under ~/docs (with its yaml sidecar), and record the distribution plus a
GO / NOT-DOMINANT verdict in the Done summary. Dominant means class (a) is the
plurality of classified content conflicts.

**Designed check-in (hard):** if file-overlap is NOT the dominant class, do not
proceed and do not stamp done — return `BLOCKED: DESIGN_CONFLICT` with the class
distribution in the block message so the human re-plans the epic toward the dominant
class. Every later task in this epic depends on this one; the block is the brake.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/derivers.ts:1206 — CommitPayload shape (files[], task_ids[], plan_epic_id) — the ground-truth actuals
- src/dispatch-failure-key.ts:605 and :619 — the work-merge-conflict and merge-escalation route arms whose reason tokens identify incident classes
- cli/escalation-brief.ts:424 — parseMergeConflictReason, the existing reason-string grammar (source branch, base branch, stderr)

**Optional** (reference as needed):
- docs/adr/0039-work-verb-merge-conflict-escalation.md — how work-verb fan-in conflicts mint and route
- keeper session events / keeper find-file-history — CLI forensics verbs if event JSON needs cross-checking

### Risks

- Sparse event history (pruned events) — widen to `git log` trailer mining (Task:/Planctl-Target: trailers + git diff-tree) for actuals; state the data window used
- Multi-task commits are ambiguous — count each incident once, mark shared attribution, never double-count

### Test notes

No repo code changes — no new tests. Evidence is the queries/commands used and the
resulting counts.

## Acceptance

- [ ] A findings doc exists under ~/docs with per-class incident counts and at least one exemplar per non-empty class
- [ ] The Done summary states the class distribution, the data window, and a GO or NOT-DOMINANT verdict
- [ ] If the verdict was NOT-DOMINANT the task returned BLOCKED: DESIGN_CONFLICT rather than stamping done

## Done summary

## Evidence
