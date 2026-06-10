## Description

**Size:** M
**Files:** tests/*.py (~25 files), tests/conftest.py (marker registrations only if gaps surface)

### Approach

Run the fast gate and `--run-slow`, then triage every failure into one of
three moves: (a) git/wire-ESSENTIAL — the test asserts on real git
history, real commits, or the real promptctl wire: mark it into the slow
bucket (`real_git` / `integration` / the wire opt-out marker); (b)
git-INCIDENTAL — the test only needs `.planctl/` disk state: leave it in
the fast path, fixing any assertion that depended on a real spawn
side-effect; (c) cross-project/roots tests — opt out of autouse
`isolated_roots` onto controlled tmp-root fixtures (never the real scan).

Starting triage map from epic recon (verify, don't trust blindly):
- Slow bucket: test_reconcile (real `Task:` trailer commits ARE the subject), test_find_task_commit (parses real git log), test_envelope (stages real files to drive touched-dirty intersection), parts of test_validate (real `.git` integrity assertions)
- Already marked, verify still coherent: test_commit, test_emit, test_init, test_refine_apply, test_epic_rm, test_run_epic_queue_jump, test_refine_context (real_git); test_scaffold (integration, per-test)
- Fast path: test_claim (asserts brief_ref, not git history — needs the render stub's error mode for BriefRenderError cases), test_worker_resume, test_close_preflight, test_resolve_task, test_task_set_tier, test_validate_marker (210 `project` refs), test_cross_project_sketch_inline
- Opt-out onto tmp roots: test_roots_discovery, test_cross_project_epic_deps
- Wire opt-out: test_sketch_refs_helper, the test_claim argv-assertion test (test_claim.py:406 area)

Use module-level `pytestmark` for whole-file buckets, decorators where
the split is per-test (test_validate, test_validate_marker per epic
recon). Tests that spawn a real `planctl` subprocess (separate
interpreter — autouse monkeypatches cannot reach it) either migrate to
the in-process `run_cli` shim (conftest.py:222-273) or go slow-bucket.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py — the task-1 seams, markers, and opt-out names
- tests/test_validate.py + tests/test_validate_marker.py — the two files needing per-test (not per-file) triage
- tests/test_reconcile.py — confirm every test needs real trailer commits (whole-file slow) or split

**Optional** (reference as needed):
- tests/test_roots_discovery.py + tests/test_cross_project_epic_deps.py — existing tmp-root fixture shapes to reuse for the opt-out path
- tests/cli_decorator/ — check for real-subprocess planctl call sites

### Risks

- False-green: a test that asserted a git side-effect now passes
  vacuously against a stub — when retagging a failure as "incidental",
  confirm the assertion still tests something real (disk state, envelope
  shape), not the stub's own output.
- Over-marking: dumping borderline tests into the slow bucket erodes the
  fast gate's regression value — prefer fixing the test to run fast.

### Test notes

Done when both gates are green: `uv run pytest tests/` (fast, skips
visible) and `uv run pytest tests/ --run-slow` (everything). Run the
subprocess spy over the full fast gate: target is near-zero spawns
(a handful of residual tolerated, each named in the Done summary).

## Acceptance

- [ ] `uv run pytest tests/` green; slow bucket visible as skips
- [ ] `uv run pytest tests/ --run-slow` green (full fidelity preserved)
- [ ] Fast gate spawn count near zero (spy-measured; residuals named)
- [ ] No fast-path test reads the real `~/code` roots (hermetic)
- [ ] Per-test triage applied where whole-file marking is wrong (test_validate, test_validate_marker at minimum)

## Done summary

## Evidence
