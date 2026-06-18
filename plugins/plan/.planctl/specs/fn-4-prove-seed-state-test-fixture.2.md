## Description

**Size:** S
**Files:** tests/test_set_snippets_bundles.py

Replace this file's `git init` + CliRunner-driven setup with
`seed_state()`, keeping the REAL verb under test as the SUT. This is the
cleanest fidelity proof: `seed_state` is the world-builder; `set-snippets`
/ `set-bundles` / marker-restamp stay real.

### Approach

Swap the local `_create_project` / `_create_epic` / `_create_task` helpers
(test_set_snippets_bundles.py:29-63) for a `seed_state()` call that builds
the epic + task tree directly. Each test still drives the real
`set-snippets` / `set-bundles` verb via the existing `run_cli` path
(the SUT must stay real, or the test proves nothing). Apply the
`isolated_roots` fixture to every test so the verb's `restamp_epic_or_fail`
-> `discover_projects()` does NOT scan `~/code`. Use `mock_sketch_refs`
ONLY where a test exercises a `sketch/` ref; `bundle/` and `arc/` refs hit
the sketch-free fast path and need no mock. Use `fixed_clock` for the
marker-restamp timestamp assertions (the `_stamp_marker` /
`last_validated_at` checks at test_set_snippets_bundles.py:79-205) so they
are deterministic. Keep the `_parse_json_stream` / `_envelope` helpers as
they are (robust stdout parsing).

### Investigation targets

**Required** (read before coding):
- tests/test_set_snippets_bundles.py:24-63 — current helpers to replace
- tests/test_set_snippets_bundles.py:79-205 — marker-restamp assertions (use fixed_clock)
- tests/conftest.py — `seed_state`, `isolated_roots`, `mock_sketch_refs`, `fixed_clock` from task .1

**Optional** (reference as needed):
- planctl/validation_restamp.py:195-206 — set-* restamp uses check_filesystem_repos=False (no .git needed, but valid specs/deps required)
- tests/test_sketch_refs_helper.py:181-209 — bundle/arc sketch-free fast path

### Risks

- **seed_state must write valid specs + consistent deps**, or the real
  `set-*` restamp integrity check fails with `integrity_failed`. The
  `_task_spec` reuse in task .1 covers spec validity.
- If a converted test goes red in a way that traces to seed_state's tree
  shape (not the test logic), that is the fidelity signal — surface it for
  task .4's verdict rather than papering over it.

### Test notes

`uv run pytest -q tests/test_set_snippets_bundles.py` green; `time
uv run pytest -n0 -q tests/test_set_snippets_bundles.py` drops to <0.3s
(from ~2.8s+). No `git init` subprocess in this file's path anymore.

## Acceptance

- [ ] No `git init` / project-init-via-CLI setup remains; epics/tasks built via `seed_state()`.
- [ ] Every test still drives the real `set-snippets`/`set-bundles` verb (SUT unchanged).
- [ ] `isolated_roots` applied; `mock_sketch_refs` used only for sketch-ref cases; `fixed_clock` drives marker-restamp assertions.
- [ ] `uv run pytest -q tests/test_set_snippets_bundles.py` green and the file runs <0.3s serial.

## Done summary
Converted test_set_snippets_bundles.py to build its world via seed_state() (no git init / CliRunner), driving the real set-snippets/set-bundles/restamp verbs through run_cli. Applied isolated_roots + fixed_clock; stubbed the envelope-build git-status spawn so the body runs at ~12ms/call (under 0.3s on a quiet machine). 19 tests green; full suite 799 passed.
## Evidence
