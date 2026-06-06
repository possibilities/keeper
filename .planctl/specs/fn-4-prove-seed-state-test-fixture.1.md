## Description

**Size:** M
**Files:** tests/conftest.py, pyproject.toml, uv.lock

Build the test-harness foundation the rest of the proof rides on: config
cleanup, an `integration` marker, the `seed_state()` state builder, and
its supporting fixtures. No existing test is converted in this task — it
only ADDS capability and must leave `uv run pytest -q` all-green.

### Approach

Config cleanup in `pyproject.toml [tool.pytest.ini_options]`: delete the
`asyncio_mode = "auto"` key, remove `pytest-asyncio` from
`[dependency-groups].dev`, run `uv lock`, and add `--strict-markers` to
`addopts` (becomes `--import-mode=importlib --timeout=30 -n auto
--strict-markers`). Extend the existing `fn-638` config comment with one
clause explaining `--strict-markers` (catches typo'd markers). Register
the `integration` marker via `config.addinivalue_line("markers", ...)` in
`tests/conftest.py::pytest_configure`, RIGHT ALONGSIDE the existing
`real_git` registration — same mechanism, lowest churn; `--strict-markers`
honors `addinivalue_line` registrations so both markers survive. (A future
sweep MAY consolidate both into a `pyproject.toml` `markers = [...]` list;
not in scope here.)

Add `seed_state(tmp_path, *, epic_id, ...) ` to `conftest.py` near
`seed_epic` (conftest.py:327). It must: (1) build the `.planctl/`
skeleton + `meta.json` exactly as `planctl/run_init.py:57-130` does
(dirs `epics/ specs/ tasks/ state/`, `meta.json = {"schema_version":
SCHEMA_VERSION}` via `atomic_write_json`, `.planctl/.gitignore` =
`state/`); (2) construct minimal epic/task dicts and pass them through
`planctl.models.normalize_epic` / `normalize_task` so every optional
field is backfilled by the SAME code the read path runs (this is the
anti-drift hook); (3) persist epic JSON to `.planctl/epics/<epic_id>.json`
and each task JSON to `.planctl/tasks/<epic_id>.<M>.json` via
`planctl.store.atomic_write_json`, and write a valid four-section task
spec (reuse the existing `_task_spec` helper, conftest.py:279) + epic spec
markdown to `.planctl/specs/<id>.md` via `atomic_write`. Caller supplies
the `fn-N` epic id — NO `scan_epic_ids_global`, NO flock, NO `git init`,
NO CliRunner. `created_at`/`updated_at` come from `now_iso()`.

Add three fixtures:
- `isolated_roots` — monkeypatch `planctl.discovery.discover_projects`
  (and/or `planctl.config.load_roots`) to return `[]` so verbs that
  re-stamp via `restamp_epic_or_fail` do NOT scan the real `~/code` tree.
  REQUIRED for hermetic, fast seed_state tests (see Risks).
- `mock_sketch_refs` — lift the `_FakeProc` / `_patch_subprocess_run`
  pattern from `tests/test_sketch_refs_helper.py:32-53`; monkeypatch
  `planctl.sketch_refs.subprocess.run` to a fake returning a real-shaped
  `CompletedProcess`-like object. Only needed by tests exercising
  `sketch/` refs (bundle/arc refs short-circuit with no spawn).
- `fixed_clock` — pin the `now_iso()` seam for timestamp/marker-restamp
  assertions. Patch the symbol WHERE IT IS RESOLVED (investigate whether
  callers do `from planctl.store import now_iso` vs `store.now_iso(...)`;
  patching the wrong namespace silently misses). Match `now_iso()`'s exact
  format (microsecond precision per CLAUDE.md "Validation marker").

Add a `seed_state` round-trip self-test: build a tree via `seed_state`,
read epic + tasks back through the REAL load/normalize path, and assert
the loaded dicts equal what `normalize_*` produces — a living fidelity
contract so any future schema change breaks here first.

Update the `conftest.py` module docstring to name `seed_state`,
`isolated_roots`, `mock_sketch_refs`, `fixed_clock` (3-5 lines; present
tense; no changelog). Per CLAUDE.md doc rule: NO backward-facing advice.

### Investigation targets

**Required** (read before coding):
- planctl/run_init.py:57-130 — exact meta.json + skeleton to mirror
- planctl/run_scaffold.py:775-840 — canonical epic/task on-disk key set
- planctl/models.py:46,142 — normalize_epic/normalize_task (the drift guard)
- planctl/store.py:113,99,230 — atomic_write_json / atomic_write / now_iso
- tests/conftest.py:279-324 — `_task_spec` (reuse) + `_scaffold_plan_yaml`
- tests/conftest.py:15-20 — existing `real_git` marker registration pattern
- tests/test_sketch_refs_helper.py:32-53 — `_FakeProc`/`_patch_subprocess_run` model

**Optional** (reference as needed):
- planctl/validation_restamp.py:149-156,195-206 — why isolated_roots is needed
- planctl/discovery.py, planctl/config.py:25 — discover_projects / load_roots
- pyproject.toml:25-33,68 — pytest config + pytest-asyncio dep line

### Risks

- **Fidelity is the whole bet.** Building dicts by hand risks drifting
  from the read path. Mitigation: route through `normalize_*` (not raw
  dicts) and ship the round-trip self-test in THIS task.
- **Hidden discovery I/O.** `restamp_epic_or_fail` calls
  `discover_projects()` -> `load_roots()` -> real `~/code` scan. Without
  `isolated_roots`, seed_state tests are neither hermetic nor fast (and
  leak cross-machine state). The fixture must land here.
- **`--strict-markers` sequencing.** It must not be added before
  `integration` is registered, or collection errors. Confirm
  `rg '@pytest.mark.asyncio' tests/` returns nothing (repo-scout confirmed
  zero) before cutting pytest-asyncio, else strict-markers errors on a
  leftover decorator.
- **`now_iso` patch namespace.** Patching the definition module when a
  caller did `from ... import now_iso` silently misses — verify import style.

### Test notes

Verify `uv run pytest -q` stays all-green (count rises by the one
self-test; no conversions yet). `uv run pytest --collect-only -q` must not
error under `--strict-markers`. The new fixtures are unused by existing
tests in this task — that is expected.

## Acceptance

- [ ] `asyncio_mode` key + `pytest-asyncio` dep removed; `uv lock` run; `--strict-markers` in `addopts`; `integration` marker registered next to `real_git`.
- [ ] `seed_state()` builds a full `.planctl/` tree via `normalize_*` + `atomic_write_json` + `_task_spec`, no git/CLI/flock; caller-supplied `fn-N` id.
- [ ] `isolated_roots`, `mock_sketch_refs`, `fixed_clock` fixtures exist and follow the cited patterns.
- [ ] A `seed_state` round-trip self-test asserts zero drift vs the real load/normalize path.
- [ ] `conftest.py` module docstring updated (present tense, no backward-facing advice); `uv run pytest -q` all-green; collection clean under `--strict-markers`.

## Done summary

## Evidence
