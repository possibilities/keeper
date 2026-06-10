## Overview

The default `uv run pytest tests/` becomes a near-subprocess-free fast gate
targeting <5s (best effort under load). Today the suite spends its 53-80s
wall on 2,299 subprocess spawns (git fixture setup, `promptctl render-spec`
at 1.5-7s each, non-hermetic discovery scans of the developer's real
`~/code` tree) — not on Python. Autouse mock fixtures close every spawn
seam in the fast path; git/wire-essential tests move into a skip-by-default
slow bucket (visible as skips, re-enabled via `--run-slow`) that CI will
own (CI setup is out of scope here). The change is harness-only:
tests/conftest.py, marker annotations, pyproject.toml, CLAUDE.md — zero
production code changes.

## Quick commands

- `time uv run pytest tests/ -q` — fast gate, must be green and ~<5s
- `uv run pytest tests/ --run-slow -q` — full suite incl. slow bucket, must be green
- `uv run pytest tests/ -q 2>&1 | tail -1` — skip count visible (slow bucket skipped, never silently deselected)

## Acceptance

- [ ] `uv run pytest tests/` runs the fast bucket only, green, near-zero subprocess spawns, <5s best-effort on a loaded machine
- [ ] `uv run pytest tests/ --run-slow` runs everything, green, unchanged fidelity for git/wire machinery
- [ ] Slow-bucket tests appear as skips in the default run (visible trace), not deselected
- [ ] Fast bucket is hermetic: no test reads the machine's real `~/code` roots or spawns `promptctl`
- [ ] Contract tests (marked into the slow bucket) pin each autouse stub's fake output against the real binary so mocks cannot silently go stale
- [ ] No changes under planctl/ (harness-only)

## Early proof point

Task that proves the approach: ordinal 1 (autouse seams + bucket mechanics).
If the autouse stubs turn out to break wide swaths of envelope assertions,
fall back to scoping stubs per-fixture instead of autouse and re-plan the
triage in task 2.

## References

- tests/conftest.py — `_mock_autocommit` (the autouse-stub-with-marker-opt-out template), `isolated_roots`, `mock_sketch_refs`, `seed_state`, `run_cli`
- planctl/invocation.py:227 — dirty-probe spawn upstream of the mocked auto-commit
- planctl/brief.py:58 — `promptctl render-spec` spawn (claim brief assembly)
- planctl/store.py:239 — `git config user.email` actor probe (short-circuited by `PLANCTL_ACTOR`)
- planctl/integrity.py:63 — repo check requires only `.git` existence
- pytest issue #11738 — core-dev guidance against `-m` expressions in addopts; skip-by-default hook + `--run-slow` flag chosen instead
- xdist issue #271 — session-scoped fixtures run once PER WORKER; keep session-autouse stubs cheap

## Docs gaps

- **CLAUDE.md**: replace the single Running Things `Test` row in place with a fast-gate row and a full-suite (`--run-slow`) row
- **pyproject.toml**: revise the `[tool.pytest.ini_options]` inline comment to match the re-tuned addopts (no appended second block)
- **tests/conftest.py**: register the new slow-bucket / opt-out markers via the existing `addinivalue_line` pattern; update fixture docstrings whose subprocess counts change

## Best practices

- **Skip, never deselect:** slow tests skipped by a `pytest_collection_modifyitems` hook stay visible in counts; `-m` in addopts silently deselects and cannot be cleanly undone [pytest issue #11738]
- **Unmarked = fast by default, guarded by loud-failing stubs:** stubs return sentinel/empty shapes so a new git-asserting test fails under them instead of false-passing; contract tests pin stub fidelity
- **xdist session fixtures run per worker:** every session-autouse stub multiplies by worker count — keep them setenv/monkeypatch-cheap [xdist #271]
- **Measure -n empirically:** for a fast suite the crossover is often -n 2/3, not auto; worker bring-up costs 2-5s under load [Trail of Bits 2025]
- **Bare `.git/` satisfies path detection only:** any code path running a real git verb against it fails hard — those tests get mocked probes or the slow bucket
