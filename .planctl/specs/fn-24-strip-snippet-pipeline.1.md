## Description

**Size:** M
**Files:** planctl/sketch_refs.py, planctl/bundle_ref.py, planctl/run_scaffold.py, planctl/run_refine_apply.py, planctl/run_epic_set_snippets.py, planctl/run_epic_set_bundles.py, planctl/run_task_set_snippets.py, planctl/run_task_set_bundles.py, planctl/cli.py, planctl/validation_restamp.py, planctl/commit_messages.py, tests/

### Approach

Delete the pipeline machinery in one atomic commit, leaf-before-root: first remove the validation passes and sketch-inline blocks from run_scaffold.py and run_refine_apply.py plus the four set-verb modules and their cli.py command blocks, then delete sketch_refs.py and bundle_ref.py once nothing imports them. The single riskiest edit is run_scaffold.py: the sketch-inline block (929-1013) reassigns epic_snippets/epic_bundles/task_snippets_list/task_bundles_list from resolver output (1010-1013) AND contains `ctx = resolve_project()` (947) consumed downstream (1034-1036). When deleting the block, keep those four names bound to their parsed YAML values and relocate the resolve_project() call above the persistence phase — persistence at 1170-1171/1213-1214 must keep writing the fields verbatim. Same shape in run_refine_apply.py (its ctx at 133 is already safe). Go-forward contract: snippets:/bundles: YAML keys pass through unvalidated into records — no regex gate, no sketch resolution; the dormant seam persists whatever the planner writes. Drop set-snippets/set-bundles from VALIDATION_RESTAMP_VERBS (validation_restamp.py:45-46) and fix the stale "14 verbs" docstring counts (64, 83). Prune any set-verb entries in commit_messages.py. DO NOT touch models.py:91-94,149-152 or brief.py:86 (dormant seam), nor the read-only field accessors in run_refine_context/run_resolve_task/run_show/run_close_preflight — verify they hold no live sketch_refs/bundle_ref imports and leave them.

### Investigation targets

**Required** (read before coding):
- planctl/run_scaffold.py:929-1013 — the inline block to delete; note the 1010-1013 reassignment and ctx at 947
- planctl/run_scaffold.py:1034-1036,1170-1171,1213-1214 — downstream consumers that must keep working
- planctl/run_scaffold.py:223-314,618-752 — the two validation passes to remove
- planctl/run_refine_apply.py:109,273-346,497,513-583,792-793 — mirror surgery
- tests/conftest.py:90,714-791 — real_sketch marker registration + autouse _mock_sketch_refs_default fixture (same-commit hazard)
- tests/test_models.py:127-184 — the 8 dormant-field tests that MUST stay green

**Optional** (reference as needed):
- planctl/cli.py:1349-1454 — the four set-verb command blocks; docstring prose at 231-240, 394-465, 624, 695-719
- pyproject.toml:38 — --strict-markers is on

### Risks

- Splitting the conftest fixture / marker / module deletion across commits breaks the entire suite at collection — this task is one atomic commit by design.
- Accidentally dropping field persistence at 1170/1213 silently kills the dormant seam; the round-trip test below is the guard.

### Test notes

DELETE: test_set_snippets_bundles.py, test_sketch_refs_helper.py, test_snippet_id_regex.py, test_cross_project_sketch_inline.py. PRUNE: test_scaffold.py (drop snippet/bundle/sketch cases around 222-371, keep bare-success), test_refine_context.py, test_close_preflight.py, test_claim.py, conftest sketch stub fixture, incidental refs in test_audit_submit/test_followup_submit/test_verdict_submit/test_seed_state/test_validate_marker. KEEP test_models.py:127-184. ADD: one permanent round-trip test loading an epic+task record with non-empty snippets/bundles lists and asserting they survive normalize + persist. Suite: `uv run pytest tests/ -q` green, plus `uv run pytest tests/ --run-slow` for the slow bucket.

## Acceptance

- [ ] sketch_refs.py, bundle_ref.py, and the four set-verb modules are deleted; cli.py carries no set-snippets/set-bundles commands; uv run ty + ruff green
- [ ] A scaffold plan YAML carrying snippets:/bundles: keys persists them verbatim into the epic/task records (manual or test-backed proof in Evidence)
- [ ] resolve_project() still runs before brief/data-dir use; no NameError on the persistence path
- [ ] test_models dormant-field tests green + new round-trip test with non-empty lists
- [ ] real_sketch marker, autouse sketch fixture, and all DELETE-list test files removed in the same commit; full suite green including --run-slow

## Done summary

## Evidence
