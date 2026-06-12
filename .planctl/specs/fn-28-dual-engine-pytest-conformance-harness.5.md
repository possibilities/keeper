## Description

**Size:** M
**Files:** tests/conftest.py, AGENTS.md, CLAUDE.md, README.md, pyproject.toml (if addopts/marker notes shift)

### Approach

Drive `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/` to green against the installed Python planctl and make the gate durable. Expect real fallout: engine-divergent assertions the spot checks missed, env leaks, stream-ordering sensitivity, timeout pressure (one subprocess + real git per invocation against --timeout=30). Fix tests by preference order: make the assertion observe disk/envelope effects > pass needed env through the invoker > mark python_only as last resort. Make the run xdist-viable: per-worker session-scoped tmp HOME (worker_id-keyed), document `--dist loadscope` as the recommended dist mode, and add a `pytest_xdist_auto_num_workers` cap so `-n auto` cannot fork-bomb a dev machine. Then land the doc surfaces: conformance row in AGENTS.md and CLAUDE.md Running Things tables (present-tense; revise the "near-subprocess-free" wording forward-facing), README/AGENTS `PLANCTL_NOW` entries if not already landed, and a CLAUDE.md convention-divergences bullet only if the python_only skip shape genuinely diverges from the slow-bucket pattern. Record the canonical conformance invocation where the Bun-foundation epic will look for it (the Running Things table is that place).

### Investigation targets

**Required** (read before coding):
- tests/conftest.py — the landed invoker, hooks, and audit results from prior tasks
- AGENTS.md:42-43 and CLAUDE.md Running Things tables — the rows being extended
- pyproject.toml:18-39 — addopts comment block; keep its claims true after this epic

**Optional** (reference as needed):
- tests/conftest.py:238 — `_git_global_config`; confirm its session config reaches subprocess git via the minimal env dict

### Risks

The long tail is unpredictable by nature — some tests may reveal genuine contract ambiguities (e.g. interleaved-stream assertions) where the right fix is a judgment call between rework and python_only. Timeout: a test issuing many sequential invocations can approach 30s under subprocess; prefer raising per-test timeout via marker over loosening the global addopts.

### Test notes

The acceptance run IS the test. Verify three invocations: default gate (green, fast), serial conformance (green), parallel conformance with `-n` (green, no flock serialization across workers — every lock path must resolve under per-worker HOME).

## Acceptance

- [ ] `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/` green serially and with `-n`, python_only skips visible in the summary
- [ ] Default `uv run pytest tests/` green with wall-clock parity to pre-epic baseline
- [ ] Running Things tables in AGENTS.md and CLAUDE.md carry the conformance row; pyproject addopts comment stays truthful; all env-seam docs landed
- [ ] No remaining unhandled test: every test is routed, converted, or visibly marked

## Done summary
Drove PLANCTL_BIN conformance run green serially and with -n auto --dist loadscope (per-worker tmp HOME, no cross-worker flock); added a pytest_xdist_auto_num_workers cap (min(cpus,8)) so -n auto cannot fork-bomb, and landed the conformance row in the Running Things table.
## Evidence
