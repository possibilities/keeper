## Description

**Size:** M
**Files:** plugins/plan/src/verbs/selection_brief.ts, plugins/plan/src/verbs/close_finalize.ts, plugins/plan/src/cli.ts, plugins/plan/test/saga-selection-brief.test.ts, plugins/plan/test/saga-close-finalize.test.ts

### Approach

Pre-select for close follow-ups: selection happens against the stored follow-up plan BEFORE finalize runs, and finalize births tasks with the selected cells — the saga's atomic scaffold-and-arm shape is untouched. Two verb changes. (1) selection-brief gains a stored-followup source (a flag on the existing verb): brief from the submitted follow-up document of a source epic instead of a live epic's todo tasks, tasks keyed by 1-based ordinal, envelope carrying the same fields (brief_ref, config_hash, input_hash, shuffle_seed, ordinal task keys, candidate_cells); input_hash hashes the stored document so provenance is reproducible. (2) close-finalize accepts an optional selection verdict (cells keyed by ordinal plus a selection provenance block, via a file input): merge the cells into the scaffold input so tasks are BORN with the selected cells — scaffold's own tier/model validation enforces the axes — write the selection sidecar for the minted epic via the existing sidecar writer with label_source: heuristic-guided, and arm exactly as today through the sole armEpicValidated seam. No verdict supplied → scaffold with the follow-up document's stamped defaults and write a degraded sidecar (outcome degraded with a reason, label_source: heuristic-default). Crash-resume adopt paths are untouched: no selection on adopt, they remain pure idempotent re-arms. The ordinal-to-minted-id mapping relies on scaffold's stable 1-based ordering. Update the finalize header comment if its commit-topology note goes stale.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/selection_brief.ts:144-265 — runSelectionBrief, todo filtering, envelope shape
- plugins/plan/src/verbs/close_finalize.ts:259-294,606-616,666-678 — scaffoldFollowup, the absent-scaffold path, and the arm block
- plugins/plan/src/selection_sidecar.ts — writeSelectionSidecar and the committed sidecar path rules (top-level selections/, never under state/)
- plugins/plan/test/saga-close-finalize.test.ts:265,351-374,536-573 — closed_with_followup, the arm assertions, and partial_followup's deliberate arm-exclusion

**Optional** (reference as needed):
- plugins/plan/src/verbs/followup_submit.ts:100 — where the stored follow-up document is validated and lives
- plugins/plan/src/verbs/scaffold.ts:426-447 — the tier/model validation that now enforces verdict cells
- docs/adr/0006-validation-marker-arm-exclusive-latch.md — the arm-seam contract this must respect

### Risks

- fn-1133 lands around the same seam (assign-cells restamp removal, arm exclusivity); this epic carries the hard dep — verify the arm call sits on the post-latch contract at implementation time.
- Verdict cells must be validated as in-axis before scaffold consumes them so a malformed verdict degrades rather than rejecting the whole finalize.

### Test notes

Saga tests: verdict supplied → minted tasks carry the verdict cells plus a heuristic-guided sidecar; no verdict → template defaults plus a degraded sidecar; adopt/resume paths byte-identical; partial_followup still arm-excluded.

## Acceptance

- [ ] A close follow-up finalized with a selection verdict mints tasks that carry the selected cells from birth, plus a committed selection sidecar recording the researched outcome
- [ ] Finalize without a verdict mints the follow-up with the document's stamped default cells and a degraded selection sidecar; arming behavior is identical in both paths
- [ ] A selection brief can be produced from a stored follow-up document, with ordinal task keys and the standard envelope fields
- [ ] Crash-resume and adopt finalize paths behave exactly as before, and the full saga suite is green

## Done summary

## Evidence
