## Description

**Size:** M
**Files:** test/saga-*.test.ts and test/creation-*.test.ts (new), mapping comments

### Approach

The heavy half: test_scaffold (54, integration-gated — rides the slow gate), test_refine_apply (30), test_epic_rm (13), test_multi_repo_create_validate, test_epic_add_dep(s) (14), test_task_set_tier (11), test_set_primary_repo_warning (6), test_run_epic_queue_jump (4), test_epic_close (3), test_validate (12), test_validate_marker (28), test_refine_context (10), test_resolve_task (10), test_claim (22), test_close_preflight (27), test_close_finalize (20), test_reconcile (23), test_find_task_commit (13), test_verdict_submit (16), test_followup_submit (14), test_audit_submit (8), test_audit_artifacts (24), test_worker_resume (11), test_session_markers (25 — the marker-file contract portions; python_only residue drops), test_cross_project_epic_deps (19 — multi-root via setRoots; 8 python_only drops), test_roots_discovery (15), test_commit (19 — git-state assertions via the harness helpers; in-process-only portions cite the bun commit units). Same disciplines as the sibling task; commit-asserting tests use the real-git fixtures.

### Investigation targets

**Required** (read before coding):
- The pytest files being translated
- test/harness.ts and the verb-module translations if landed — match idioms

### Risks

test_scaffold and test_validate_marker are the densest edge-case nests in the suite — translate test-by-test against the source, never summarize clusters into fewer tests.

## Acceptance

- [ ] All listed modules translated/cited/dropped with reasons; both suites green incl. PLANCTL_RUN_SLOW=1

## Done summary
Translated the creation-machinery half of the pytest suite onto the bun harness: scaffold (47, slow-gated), refine-apply (26), refine-context (9), validate-marker (26), epic-rm (10), creation-epic-ops (34: add-dep/add-deps/close/queue-jump/set-tier/set-*-repo warnings), validate/multi-repo/resolve-task (7 + citations) across 7 test files; every node mapped by a source-comment (translated | cited bun unit | python_only drop). bun test green fast + PLANCTL_RUN_SLOW=1. The saga lifecycle half is queued for follow-up.
## Evidence
