## Overview

First epic of the Python→Bun migration program: make the pytest suite dual-engine. Default engine runs in-process via CliRunner exactly as today — the fast gate stays serial and near-subprocess-free. Conformance engine (enabled by setting `PLANCTL_BIN`) runs every CLI invocation as `subprocess.run([$PLANCTL_BIN, ...])` against an arbitrary planctl binary, with real git and a tmp-HOME-isolated machine surface. Proven in this epic against the installed Python planctl; later program epics point the same gate at the Bun binary, making this suite the executable parity spec for the port.

## Quick commands

- `uv run pytest tests/` — default fast gate, must stay as green and as fast as today
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/` — conformance run against the installed Python planctl (slower: one subprocess + real git per invocation)

## Acceptance

- [ ] `PLANCTL_BIN=<python planctl> uv run pytest tests/` is green; every non-python_only test exercises the binary as a real subprocess with real git
- [ ] `python_only` tests are skipped-VISIBLE in conformance runs (same skip mechanism as the slow bucket; never silently deselected)
- [ ] Default `uv run pytest tests/` stays as green and as fast as before this epic — no subprocess leak into the fast path
- [ ] `PLANCTL_NOW` is honored by the binary and documented as a pinned cross-implementation contract alongside `PLANCTL_ACTOR`
- [ ] Conformance mode is xdist-viable: `-n` works, HOME isolation is per-worker, no cross-worker flock serialization

## Early proof point

Task that proves the approach: ordinal 2 (unified invoker seam + subprocess engine). If the two result shapes cannot unify cleanly behind one object, fallback: keep `run_cli` as the subprocess-only seam and convert test files to it incrementally instead of aliasing — scoped retreat, same acceptance.

## References

- Program context: epic ① of ~6 (① harness → ② bun foundation → ③–⑤ verb waves → ⑥ cutover + Python retirement); dual-engine pytest is the locked parity gate
- tests/conftest.py:412-477 `run_cli`/`_CliResult` — the invoker-seam seed; :119/:191/:220/:693 autouse isolation stubs; :712 `fixed_clock`; :103-116 slow-bucket skip-visible hook; :238 `_git_global_config`
- tests/test_generated_guard_hook.py:38-58 and :437-512 — PATH-shim stub binary and cross-process HOME-isolation precedent (reuse, do not reinvent)
- planctl/store.py:230-261 `get_actor` (the `PLANCTL_ACTOR` seam to mirror); store.py:264 `now_iso`
- Sizing facts: `.output` used 604×, `.exit_code` 347×, `.stdout` 164×, `.stderr` 77×; 124 CliRunner instantiations across 40 files; suite collects 777 tests
- Conformance and the slow bucket stay orthogonal: conformance forces the real-git FIXTURE branch suite-wide but slow-bucket tests remain skip-by-default unless `--run-slow`

## Docs gaps

- **README.md**: add `PLANCTL_NOW` to the env-vars list (one-liner, present-tense contract)
- **AGENTS.md**: add the conformance row to the Running Things table; add `PLANCTL_NOW` to the env-vars list
- **CLAUDE.md**: align the Running Things table with the conformance row; convention-divergences bullet only if the python_only skip shape diverges from the slow-bucket pattern

## Best practices

- **Minimal subprocess env dict:** build from scratch (HOME, XDG_*, GIT_CONFIG_GLOBAL → empty temp file not /dev/null, GIT_CONFIG_SYSTEM=/dev/null, PATH, PLANCTL_ACTOR), never `os.environ.copy()` — prevents XDG and credential leakage [practice-scout]
- **Parse-and-compare JSON, never byte-compare:** exit codes are the most stable contract; assert stderr presence/category, not exact wording [practice-scout]
- **xdist:** session-scoped per-worker tmp HOME keyed by worker_id; `--dist loadscope`; worker cap via `pytest_xdist_auto_num_workers` [pytest-xdist docs]
