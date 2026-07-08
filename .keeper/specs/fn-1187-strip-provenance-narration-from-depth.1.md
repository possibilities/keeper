## Description

Addresses F1 [PROVENANCE_COMMENT]. Repo rule #0 forbids fn-ids and
past-tense provenance in code comments; the depth-band wiring commit added
several. Remove the provenance clauses and prior-finding labels while
keeping each comment's forward-facing invariant statement. Move any
rationale worth preserving to the commit message.

Files:
- plugins/plan/src/verbs/close_preflight.ts — the DEPTH_BAND_THRESHOLD_KEYS comment: delete the "this pairing drifting apart is exactly how the F1 wiring bug shipped (the runtime read min_tasks/min_diff_lines while the file provided min_task_count/min_diff_loc)" clause; keep the "the runtime consumer and the config's schema cannot silently diverge again" invariant sentence.
- plugins/plan/scripts/audit-policy-check.ts — the header block (~line 19) "(this drifting apart, undetected, is exactly how the F1 wiring bug shipped)" and the coerceDepthBand doc (~line 105) "instead of silently diverging (F1)": drop the "(F1)" label and the "how it shipped" clause, keep the forward-facing "coerceDepthBand requires each entry to carry exactly the keys" statement.
- plugins/plan/test/consistency-audit-policy.test.ts — the "F1 shipped undetected" banner comment (~line 210) and the "(F3)" label in the describe title (~line 218): drop the provenance banner and the bare fn-id label.
- plugins/plan/test/saga-close-preflight.test.ts — the "hole that let F1 ship" banner (~line 792) and the "(F2 regression)" / "(F1 regression)" labels in the describe/test titles (~lines 797, 1030): drop the provenance banner and the fn-id labels; a descriptive scenario name may stay.

## Acceptance

- [ ] grep for F1/F2/F3 and "shipped" across the four files returns no provenance narration or fn-id label
- [ ] Each comment retains its forward-facing invariant sentence
- [ ] bun run test:full (plan suite) stays green

## Done summary
Stripped fn-id/provenance narration (F1/F2/F3, past-tense 'how it shipped') from depth-band comments and test banners in close_preflight.ts, audit-policy-check.ts, and two plan test files; forward-facing invariant sentences preserved.
## Evidence
