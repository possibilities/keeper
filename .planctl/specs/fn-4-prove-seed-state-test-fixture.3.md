## Description

**Size:** M
**Files:** tests/test_scaffold.py

Carve `test_scaffold.py` along the honest seam repo-scout surfaced: the
tests that exercise scaffold's OWN write path (and so require real git +
the integrity gate) get marked `integration` and leave the fast gate; only
tests that genuinely assert downstream schema SHAPE (not scaffold
behavior) convert to `seed_state`. Do NOT pretend behavior tests convert.

### Approach

Read all 60 tests and classify each:
- **Genuinely integration** (KEEP real, mark `integration`): anything
  asserting a scaffold FAILURE envelope (`bad_yaml`, `tier_invalid`,
  `dep_invalid`, `dep_cycle`, `id_collision`, `duplicate_epic`,
  `ref_invalid`), the single-envelope/single-commit boundary, the real
  `sketch/` fast-path, `missing_session_id` fail-closed, and
  `test_scaffold_invocation_raise_persists_written_tree` (atomicity). These
  REQUIRE scaffold's integrity gate, which needs real `.git/`
  (`check_filesystem_repos=True`, run_scaffold.py:899-910) — they cannot
  and must not become `seed_state` tests.
- **Convertible** (only if it asserts resulting on-disk SHAPE and nothing
  scaffold-specific): rewrite to build the tree with `seed_state()` and
  assert shape directly. Per repo-scout this set is SMALL — be honest;
  a test that needs scaffold to have produced the tree stays integration.

Apply `pytestmark = pytest.mark.integration` at module level if the
residual unit set is empty, OR mark the integration tests individually and
leave the converted ones unmarked. Whichever keeps the file readable.
Preserve every behavioral assertion — this is a re-tier, not a coverage cut.

**Fallback (documented):** if the in-process split proves tangled or no
test honestly converts, mark the WHOLE file `integration` and record in
task .4 that `test_scaffold.py` stays fully integration — that is still a
valid proof outcome (it removes the file from the fast gate; the
seed_state fidelity proof then rests on task .2 alone).

### Investigation targets

**Required** (read before coding):
- tests/test_scaffold.py — all 60 tests (classify each)
- planctl/run_scaffold.py:899-910 — integrity gate requires real .git (why scaffold tests stay integration)
- tests/conftest.py — `seed_state` + `integration` marker from task .1

**Optional** (reference as needed):
- planctl/run_scaffold.py:775-840 — on-disk schema (for any shape-only conversion)
- tests/conftest.py:112-152 — `planctl_git_repo` (the fixture integration tests keep)

### Risks

- **Over-conversion erases coverage.** Converting a behavior test to
  seed_state makes it test nothing. The default is KEEP-real-and-mark;
  convert only with a clear shape-only justification.
- **Marker granularity.** Module-level `pytestmark` vs per-test marks —
  pick by what the residual unit set looks like after classification.

### Test notes

`uv run pytest -q tests/test_scaffold.py` green (all tests, both tiers).
`uv run pytest -q -m "not integration" tests/test_scaffold.py` runs only
the converted unit subset (fast). `uv run pytest -q -m integration
tests/test_scaffold.py` runs the real-git slice. Total assertion count
preserved vs baseline.

## Acceptance

- [ ] Every scaffold-behavior / failure-envelope / atomicity / commit-boundary test is marked `integration` and still runs real git.
- [ ] Any converted test is shape-only and justified; no behavioral coverage dropped.
- [ ] `uv run pytest -q tests/test_scaffold.py` green; `-m "not integration"` excludes the real-git slice; `-m integration` runs it.
- [ ] If the fallback fired (whole file integration), it is noted for task .4.

## Done summary
Marked all 58 git-driven scaffold-behavior tests `integration`; left the 2 verb-registration unit tests in the fast gate. No test honestly converted to seed_state (every behavior test asserts what scaffold itself produces/rejects/commits, requiring the real-git integrity gate) — re-tier only, zero coverage cut. Fast slice: 2 passed in 0.51s; integration slice: 58 passed; total 60 green.
## Evidence
