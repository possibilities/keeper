## Description

**Size:** M
**Files:** tests/test_readonly_verbs.py (new)

### Approach

Write the engine-agnostic conformance spec for the four verbs BEFORE any bun code exists, and prove it against the Python implementation in both engines. Seed every fixture with the CLI-free `seed_state` disk builder plus `monkeypatch.chdir` (copy the tests/test_session_markers.py fixture pattern — its seeding shape transfers, not its assertions), so under conformance only the verb-under-test crosses to `PLANCTL_BIN`. Coverage per verb: `state-path` envelope; `detect` found-true (meta.json present, name/path/schema_version) and found-false (bare envelope, exit 0, no hard error); `status` counts including the never-claimed default (absent runtime overlay → todo) and the empty-project zero-count shape; `epics` ordering via parse_id including an unparseable-id fixture (sorts last). Cross-cutting pins: `--format yaml` and `--format human` outputs for status and epics (capture the byte-exact Python output as the expected strings); the trailing planctl_invocation line byte-for-byte (compact separators, field order files/op/target/subject/touched_path_files/repo_root/state_repo, target null for these verbs); missing-project error envelope + exit 1 for state-path/status/epics; one fixture with a non-ASCII title (pins ensure_ascii=False ↔ JS-default unicode parity). Every test must pass identically in the default in-process engine and under `PLANCTL_BIN=<python planctl>` — that dual green is this task's exit, and it makes the module the executable spec the bun port targets.

### Investigation targets

**Required** (read before coding):
- tests/test_session_markers.py — the seed_state + chdir + run_cli fixture pattern to copy
- tests/conftest.py — seed_state (CLI-free disk builder), run_cli, _subprocess_env; understand what crosses the process boundary
- planctl/invocation.py:173 — exact trailer field set and order
- planctl/run_detect.py, run_status.py, run_epics.py, run_state_path.py — the envelope shapes being pinned (schema_version defaults: detect 0, status 1)

**Optional** (reference as needed):
- tests/test_envelope_shape.py:131 — _parse_primary helper for stripping the trailer line (reuse or mirror)
- planctl/_util.py:92 — yaml_dump options, to understand what the yaml pins will look like

### Risks

Over-pinning: capture expected strings from real Python output, not hand-typed approximations — a typo in an expected yaml block becomes a false conformance failure for the bun port. Under-pinning: skipping the trailer or human/yaml assertions ships those surfaces ungated for the rest of the program.

### Test notes

Three invocations must be green: `uv run pytest tests/test_readonly_verbs.py` (in-process), `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/test_readonly_verbs.py` (subprocess vs Python), and the default full fast gate (no regressions).

## Acceptance

- [ ] tests/test_readonly_verbs.py covers all four verbs incl. yaml/human pins, trailer byte-equality, missing-project errors, non-ASCII fixture, schema_version asymmetry
- [ ] Green in the default engine AND under PLANCTL_BIN pointed at the Python planctl
- [ ] No existing test or conftest behavior modified; full fast gate stays green

## Done summary
Added tests/test_readonly_verbs.py: engine-agnostic conformance spec pinning state-path/detect/status/epics byte-for-byte (json/yaml/human, trailer, missing-project errors, schema_version asymmetry, non-ASCII title). Green in-process and under PLANCTL_BIN=python planctl.
## Evidence
