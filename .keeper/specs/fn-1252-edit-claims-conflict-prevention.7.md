## Description

**Size:** M
**Files:** plugins/plan/src/verbs/claims_report.ts (new), the plan CLI verb registry module, a claims-review dataset module mirroring the selection-review seam (new), plugins/plan/test/saga-claims-report.test.ts (new), plugins/plan/README.md

### Approach

Close the predicted-vs-actual loop out-of-band — never a fold (a files-per-task
projection folded from history is the re-fold time-bomb the invariants forbid). A
read-only-inputs verb `keeper plan claims-report <epic_id>` runs after an epic lands:
per task, actual = the union of Commit-event files[] across commits whose Task:
trailers name it (read-only keeper.db; .keeper/ control paths excluded; multi-task
commits counted once and marked shared); predicted = the task's claims (paths exact,
globs matched against actuals, resource tokens reported separately — they have no
path denominator). Emit per-task and per-certainty-tier precision AND recall (never
accuracy), the unclaimed-task list, and the conflict join: for each conflict_files
row touching the epic, whether the colliding pair's claims intersected —
predicted-overlap-to-actual-conflict precision, the money metric. The dataset commits
to a new .keeper sibling directory (claims-reviews/<epic>.json) mirroring the
selection-review seam: schema-versioned, write-once on own existence, --force to
re-derive; verify the daemon's plan-path classifier ignores the new directory (no
fold effect). Selective-labels caveat rides the report: hard-serialized pairs never
raced, so their silence is bias, not precision.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/derivers.ts:1206 — CommitPayload (files[], task_ids[], plan_epic_id), the actuals source
- plugins/plan/src/selection_review_file.ts — the committed-dataset seam to mirror (schema version, write-once, --force)
- plugins/plan/src/edit_claims.ts — claim types and glob matcher the metrics reuse
- the daemon's plan-path classifier (classifyPlanPath) — confirm the new directory classifies as none

**Optional** (reference as needed):
- docs/adr/0018-out-of-band-selection-review-skill.md — the out-of-band review precedent this mirrors
- cli/escalation-brief.ts — how dispatch_failures rows are read for the conflict join

### Risks

- Events pruned beyond the epic's window — degrade to git trailer mining for actuals and say so in the report; never fail silently
- conflict_files may be empty on older rows — the conflict join degrades to absent, not an error

### Test notes

Saga test over a fixture epic with synthetic Commit events: per-tier precision/recall
computed correctly for exact, glob, and unclaimed cases; write-once then --force;
.keeper paths excluded from actuals; deterministic output ordering.

## Acceptance

- [ ] The report for a landed epic yields per-task and per-tier precision and recall, resource claims reported separately, and an unclaimed-task list
- [ ] The committed dataset is schema-versioned, write-once, and re-derivable only via --force; the daemon ignores the new directory
- [ ] .keeper control paths are excluded from actuals and multi-task commits are marked shared, counted once
- [ ] When conflict_files rows exist for the epic the report scores predicted-overlap against actual-conflict; absent rows degrade gracefully

## Done summary

## Evidence
