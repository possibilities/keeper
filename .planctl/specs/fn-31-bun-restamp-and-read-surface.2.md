## Description

**Size:** M
**Files:** tests/test_restamp_verbs.py (new)

### Approach

The mutating-side spec, proven against Python first. seed_state-seeded throughout. Coverage per verb: task set-tier (gate on TASK_TIERS, not a restamp member — no marker change), set-description/set-acceptance (file and stdin input, section patched, marker re-stamped under frozen PLANCTL_NOW), set-target-repo (touched_repos recomputed from child union before restamp; two-file commit scope), task reset (runtime cleared to todo, spec sections emptied, worker_done_at nulled, --cascade via dependents), epic set-branch/set-title (plain writes, no restamp), set-primary-repo/set-touched-repos (warn-and-write: warnings array + WARN: stderr + exit 0 + restamp), invalidate and queue-jump (short-circuit when already null/true → readonly envelope no commit; else write + mutating emit; queue_jump=true on the invocation), refine-context --invalidate (both branches), add-dep (fn-N normalization to full slug, cross-project resolution via multi-root seed_state + set_roots, cycle → rollback with prior state restored), add-deps (--skip-invalid result statuses WIRED/ALREADY_PRESENT/SKIPPED_*, error priority order, no write when zero new edges), rm-dep (idempotent). Cross-cutting: a restamp-failure case (corrupt a sibling task spec so the post-write integrity check fails → integrity_failed compact envelope, exit 1, structural write STILL on disk, marker stale); commit subjects for each mutating verb; auto-commit file scoping when a verb writes two files.

### Investigation targets

**Required** (read before coding):
- planctl/validation_restamp.py — failure envelope and no-rollback semantics
- planctl/run_epic_add_deps.py — error priority and results statuses
- planctl/run_task_set_target_repo.py — recompute-before-restamp ordering
- planctl/run_epic_invalidate.py + run_epic_queue_jump.py — the short-circuit pattern
- tests/test_worker_verbs.py — commit-count and envelope assertion idioms to reuse

**Optional** (reference as needed):
- tests/test_cross_project_epic_deps.py two_projects/three_projects fixtures — the multi-root shape to re-express with seed_state

### Risks

The restamp-failure fixture must corrupt state in a way both engines detect identically — use a missing spec file (a pinned integrity error) rather than exotic corruption.

### Test notes

Green three ways before done; commit-asserting tests carry real_git for the default engine.

## Acceptance

- [ ] Every in-wave mutating verb covered incl. restamp-failure fail-forward, add-dep rollback, short-circuit no-commit branches, multi-root dep resolution
- [ ] Green in default engine and against Python; fast gate unchanged

## Done summary
Added tests/test_restamp_verbs.py — the engine-agnostic conformance spec for the in-wave mutating verbs (setters, dep editors, short-circuit/conditionally-mutating verbs, restamp-failure fail-forward, add-dep cycle rollback), all seed_state-seeded and green in the default engine and against the Python binary.
## Evidence
