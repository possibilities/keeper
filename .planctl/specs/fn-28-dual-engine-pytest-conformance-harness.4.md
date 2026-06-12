## Description

**Size:** M
**Files:** tests/conftest.py, tests affected by the audit (~16 monkeypatch-heavy files, 8 CONFIG_PATH patch sites, fixed_clock users)

### Approach

Three moves. (1) Register a `python_only` marker in `pytest_configure` and skip it — visible, never deselected — in the same `pytest_collection_modifyitems` hook as the slow bucket, with the inverse trigger (skips when `PLANCTL_BIN` is set). Reconcile the marker registry in the same pass: `real_promptctl`/`real_sketch` are referenced in pyproject.toml and CLAUDE.md but never registered and absent from `_SLOW_BUCKET_MARKERS` — register them or excise the stale references, matching what the code actually does (pyproject's claim of autouse promptctl stubs is stale; verify against conftest before writing anything). (2) Convert the cross-boundary-convertible tests: `fixed_clock` becomes a plain env-setter for `PLANCTL_NOW` (valid in both engines now that the seam exists — delete the now_iso monkeypatch); the 8 `monkeypatch.setattr("planctl.config.CONFIG_PATH", ...)` sites convert to writing a real config.yaml under the test's HOME (in-process: monkeypatched HOME or CONFIG_PATH as today is fine for default engine — but prefer the one mechanism that works in both engines where cheap). (3) Audit the remaining ~16 files that monkeypatch planctl internals or assert on stub-captured Python state: classify each test conformance-safe (disk/envelope assertions — leave alone), convertible (rework to observable effects when cheap), or `python_only` (Python internals ARE the subject — mark it). Default to marking over heroic rework; the marked set is the documented python-only residue the Bun port's translated suite re-expresses later.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py:103-116 — the slow-bucket skip-visible hook to extend
- tests/conftest.py:47-69 — marker registration under --strict-markers
- tests/conftest.py:712-726 — fixed_clock, being reimplemented as env-setter
- The 8 CONFIG_PATH patch sites: grep `monkeypatch.setattr("planctl.config.CONFIG_PATH"` across tests/

**Optional** (reference as needed):
- tests/test_models.py, tests/test_util_vendored.py, tests/cli_decorator/ — canonical python_only candidates (internals are the subject)
- tests/test_stub_contracts.py — stub-fidelity pins; decide whether each pin is python_only or retired alongside its stub

### Risks

Over-marking erodes the conformance gate's coverage; under-marking blocks the green gate on tests that can never cross the boundary. The classification rubric (what does the assertion observe?) is the load-bearing judgment — record the rationale per file in the audit commit message, not in code comments.

### Test notes

`PLANCTL_BIN=... uv run pytest --collect-only` style dry runs should show python_only tests as skips with the marker reason. fixed_clock users must pass in BOTH engines after conversion.

## Acceptance

- [ ] `python_only` registered and skip-visible under conformance via the collection hook; phantom marker references reconciled with reality
- [ ] `fixed_clock` sets `PLANCTL_NOW`; no monkeypatch of `now_iso` remains anywhere
- [ ] All 8 CONFIG_PATH patch sites converted or marked; every audited file is classified routed/converted/marked with none left unhandled
- [ ] Default fast gate green throughout

## Done summary
Completed the dual-engine audit: registered the python_only marker (skip-visible under conformance), made fixed_clock set PLANCTL_NOW (no now_iso monkeypatch remains), reconciled phantom markers, and converted every discovery-driving CONFIG_PATH site to the engine-agnostic set_roots seam — classifying the residual fault-injection/HOME-coupled tests as python_only. Default fast gate and full PLANCTL_BIN conformance suite both green.
## Evidence
