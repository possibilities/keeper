## Description

**Size:** M
**Files:** plugins/plan/src/selection_review_file.ts, plugins/plan/src/verbs/selection_audit_brief.ts, plugins/plan/src/verbs/selection_review_submit.ts, plugins/plan/test/saga-selection-audit-brief.test.ts, plugins/plan/test/saga-selection-review-submit.test.ts, plugins/plan/test/audit-verdict-submit.test.ts

### Approach

Make the mechanical selection-audit brief a committed artifact and harden the review dataset's provenance keys. The brief moves from gitignored state to a committed top-level data-dir sibling (`.keeper/selection-audit-briefs/<epic>.json`), written via the committed-artifact seam (atomic JSON write + touched-path record so the verb's auto-commit lands it; the plan-path classifier must treat the new dir as non-plan-state). Guard semantics flip to fit the close-then-grade-later split: the brief verb becomes write-once on its OWN existence (a re-close skips idempotently; `--force` re-derives), no longer keyed on a committed review. The brief's content drops the selector's rationale/confidence/label_source fields — the grading pass is blinded; those stay in the selection sidecar for calibration only. The inline spec_md snapshot stays (self-contained grade-time stability). `selection-review-submit` keeps its committed-dataset write and validation, loses the board-overlay flag write entirely (including the now-dead misfit/flag_set emit field — the surviving envelope carries counts + graded task ids), and its file schema bumps to stamp three new verdict-key fields — rubric_version, judge_model_version, prompt_hash — alongside the existing config/input hashes; submit refuses on an existing review unless `--force` (the deliberate re-grade path). Existing committed review files remain readable (additive schema, version-discriminated).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/selection_sidecar.ts:11-24 — the three committed-artifact invariants to copy verbatim (top-level sibling, atomicWriteJson + recordTouched, classifyPlanPath none)
- plugins/plan/src/selection_review_file.ts:58-90 — ReviewVerdict/SelectionReviewFile schema and selectionAuditBriefPath (the path seam both verbs import)
- plugins/plan/src/verbs/selection_audit_brief.ts:213 and :319 — the REVIEW_EXISTS guard to rework and the atomicWriteRaw call to replace
- plugins/plan/src/verbs/selection_review_submit.ts:170, :302-339, :341-363, :370 — force guard, dataset write (keep), overlay write (remove), flag_set emit (drop)
- plugins/plan/src/store.ts — atomicWriteJson vs atomicWriteRaw, recordTouched

**Optional** (reference as needed):
- plugins/plan/src/state_path.ts and the classifyPlanPath allowlist — confirm exact-prefix classification for the new dir
- docs/problem-codes.md:159-181 — which codes survive on the reworked guards

### Risks

- The write-once/--force interplay is the epic's crux — get the guard matrix (brief exists / review exists / force) into the saga tests explicitly
- Existing committed reviews (three epics) must stay parseable — version-discriminate, never rewrite them

### Test notes

Update the three saga tests: brief lands a commit (mirror saga-selection-review-submit's commit assertions), re-close idempotence (second brief call skips, no second commit), submit stamps the new keys and refuses-then-forces correctly, overlay flag assertions deleted.

## Acceptance

- [ ] `keeper plan selection-audit-brief <epic>` lands a git-committed brief under the data dir; a second invocation without force skips idempotently with no new commit
- [ ] The committed brief carries no selector rationale/confidence/label_source fields; the spec snapshot and diff stats remain
- [ ] `keeper plan selection-review-submit` writes no board/overlay state, stamps rubric_version + judge_model_version + prompt_hash in the committed dataset, and refuses an existing review without `--force`
- [ ] Pre-existing committed review files still parse and join by config_hash
- [ ] The daemon never folds the new brief dir as plan state
- [ ] `bun test` green in the plan plugin

## Done summary

## Evidence
