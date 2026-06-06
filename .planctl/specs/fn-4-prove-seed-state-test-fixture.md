## Overview

Validate the riskiest assumption in the fast-test-suite charter
(`~/docs/2026-06-06-fast-test-suites/planctl.md`): that a `seed_state()`
test helper built on planctl's OWN serialization seams
(`normalize_epic`/`normalize_task` -> `atomic_write_json`) can replace the
`git init` + CliRunner `scaffold` test setup with ZERO schema drift, and
that doing so removes the heavy pair (`tests/test_scaffold.py` +
`tests/test_set_snippets_bundles.py`, ~90% of serial test cost) from the
fast gate, collapsing it from ~48s toward <5s. This epic is ONLY the proof
slice. The full 14-file sweep is a SEPARATE follow-up epic, planned only if
this proof lands.

## Quick commands

- `uv run pytest -q`  # regression oracle — must stay all-green
- `uv run pytest -q -m "not integration"`  # the emerging fast gate
- `time uv run pytest -n0 -q tests/test_scaffold.py tests/test_set_snippets_bundles.py`  # heavy-pair baseline (~48s today)
- `time uv run pytest -n0 -q -m "not integration" tests/test_scaffold.py tests/test_set_snippets_bundles.py`  # fast-gate slice of the pair (proof target <5s)

## Acceptance

- [ ] `seed_state()` exists, routes through `normalize_epic`/`normalize_task` + `atomic_write_json`, and a round-trip self-test proves zero drift vs the real read path.
- [ ] `tests/test_set_snippets_bundles.py` drives its real verbs against a `seed_state` tree (no `git init`), stays green, and drops to <0.3s.
- [ ] `tests/test_scaffold.py`'s genuinely-integration tests are marked `integration` and leave the fast gate; any honestly-convertible schema-shape tests use `seed_state`.
- [ ] `uv run pytest -q` stays all-green throughout (test count may shift as tests are added/converted/deleted — green, not a fixed number, is the oracle).
- [ ] A GO/NO-GO verdict for the full sweep is recorded with before/after timing numbers and any seed_state fidelity findings.

## Early proof point

Task that proves the approach: `.2` — the first `test_set_snippets_bundles`
test passing green against a `seed_state`-built tree (driven through the
REAL `set-snippets` verb) is the fidelity proof. If `seed_state` cannot
build a tree the real verb accepts, fall back to the narrower proof
(convert only `test_set_snippets_bundles`, keep `test_scaffold` fully
`integration`) and report that seed_state needs more work before the sweep.

## References

- Charter: `~/docs/2026-06-06-fast-test-suites/planctl.md`
- On-disk schema scaffold writes: `planctl/run_scaffold.py:775-840`
- Anti-drift seam: `planctl/models.py:46` (`normalize_epic`), `:142` (`normalize_task`)
- Mock-the-spawn pattern: `tests/test_sketch_refs_helper.py:32-53`
- GOTCHA — `set-*` verbs scan `~/code` via discovery: `planctl/validation_restamp.py:149-156`, `planctl/config.py:25` (`load_roots`)

## Docs gaps

- **`CLAUDE.md` "Running Things" table**: the two-row fast/all run-shape split belongs to the SWEEP (the fast gate is not real until most integ files convert/mark) — do NOT add it here. This proof touches only the `pyproject.toml` pytest-config comment and the `tests/conftest.py` module docstring.
