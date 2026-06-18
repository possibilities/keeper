## Description

**Size:** M
**Files:** all tests/test_*.py with inline CliRunner usage (~40 files), tests/conftest.py (guard test)

### Approach

Mechanical sweep: replace every inline `CliRunner()` instantiation and `runner.invoke(cli, [...])` call with the unified invoker from the previous task, preserving env/cwd/input semantics per callsite. The result-object aliases mean assertions stay untouched in the overwhelming majority of sites — only attribute-incompatible edges need hand-care. The single `CliRunner(mix_stderr=False)` site (tests/test_worker_resume.py:41) converts to explicit `.stdout`/`.stderr` access through the invoker (which always captures both streams separately); verify its assertions hold in both engines. Add a guard test asserting no `CliRunner(` usage exists outside the invoker implementation so the seam cannot silently erode. Work file-by-file; the default fast gate stays green after every batch.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py — the landed invoker from the previous task (read its final shape, not this spec's sketch)
- tests/test_worker_resume.py:41 — the sole mix_stderr=False site

**Optional** (reference as needed):
- tests/test_close_preflight.py, tests/test_refine_context.py — the densest invoke files (18 and 12 callsites) — good first batches to validate the mechanical recipe

### Risks

Env-passing semantics differ: CliRunner's `env=` merges into the in-process os.environ temporarily; the subprocess engine passes env into `subprocess.run`. The invoker owns reconciling this — callsites must not grow engine-conditional logic.

### Test notes

Green default gate after each file batch is the loop invariant. Spot-check a few converted files under `PLANCTL_BIN` conformance to catch engine-divergent assertions early, but full conformance green is the final task's job, not this one's.

## Acceptance

- [ ] Zero direct CliRunner usage outside the invoker implementation, enforced by a guard test
- [ ] All ~124 former callsites route through the unified invoker with semantics preserved
- [ ] Default `uv run pytest tests/` green and as fast as before the sweep

## Done summary
Swept all inline CliRunner callsites across the test suite onto the unified run_cli invoker, with a guard test enforcing no direct CliRunner instantiation outside the sanctioned allowlist. Default fast gate green (592 passed, 195 skipped).
## Evidence
