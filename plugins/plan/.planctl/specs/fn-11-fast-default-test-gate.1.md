## Description

**Size:** M
**Files:** tests/conftest.py, pyproject.toml, tests/test_stub_contracts.py (new)

### Approach

Build every fast-path seam in tests/conftest.py, following the
`_mock_autocommit` template (autouse fixture, early-return on an opt-out
marker via `request.node.get_closest_marker`, stub mirrors the real
return contract). Seams, in dependency order:

1. **PLANCTL_ACTOR** — session-autouse `setenv("PLANCTL_ACTOR", "test@example.com")`; kills the `git config user.email` spawn (store.py:239) with zero patching.
2. **Brief render stub** — autouse fake of the `promptctl render-spec` spawn at the `planctl.brief` subprocess seam, returning real-shaped human-format prose; must support an error mode so tests asserting `BriefRenderError` handling still exercise the failure contract. Opt-out marker (e.g. `real_promptctl`) for wire-format tests.
3. **Sketch-refs stub** — flip the existing `mock_sketch_refs` to autouse with the same opt-out marker; keep the opt-in name importable so existing call sites keep working during task 2 triage.
4. **Roots isolation** — flip `isolated_roots` autouse. It patches TWO seams (`planctl.discovery.discover_projects` AND `planctl.config.load_roots`) — keep both. Verify empty discovery is behavior-neutral at all five prod call sites (integrity.py:471, run_epic_add_deps.py:233, run_scaffold.py:858, run_epic_create.py:61, validation_restamp.py:149); the four files already using it opt-in (incl. scaffold-heavy ones) are evidence. Opt-out path must land tests on controlled tmp-root fixtures, never the real `~/code` scan.
5. **Dirty-probe stub** — autouse fake of the `git status --porcelain --untracked-files=all -- .planctl/` spawn in `build_planctl_invocation` (invocation.py:227); runs upstream of the already-mocked auto-commit so it needs its own stub. Mirror `--untracked-files=all` semantics by walking `.planctl/` on disk (faithful for the fresh-repo case every test fixture creates) so envelope `files`/`subject` assertions keep passing. `real_git` opts out.
6. **Bare `.git/` fixtures** — `project` / `multi_repo_project` write a minimal `.git/` skeleton (HEAD, config, refs/heads/) instead of spawning `git init`, except when the test carries `real_git` (then keep the real init+commit path). `planctl_git_repo` keeps real git (its consumers are slow-bucket candidates).
7. **Bucket mechanics** — register the slow-bucket marker(s) in `pytest_configure` (`--strict-markers` errors on unregistered) plus a `pytest_addoption --run-slow` flag and a `pytest_collection_modifyitems` hook that adds `pytest.mark.skip` to `real_git`/`integration`/wire-marked tests unless the flag is passed. Skip, never deselect. Do NOT put `-m` in addopts.
8. **Contract tests** — new small module, all tests marked into the slow bucket, pinning each stub's fake output shape against the real binary (`git status --porcelain` shape, `promptctl render-spec --format human` shape) so a drift in the real wire breaks CI, not silently the mocks.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py:38-63 — `_mock_autocommit`: the autouse+opt-out template and stub-contract convention
- tests/conftest.py:457-511 — `isolated_roots` (dual seam) and `mock_sketch_refs` (real-shaped fake proc)
- planctl/invocation.py:220-244 — `_dirty_planctl_paths` argv + parse shape the stub must mirror
- planctl/brief.py:43-80 — render-spec argv, stdout use, and the `BriefRenderError` failure contract
- planctl/integrity.py:60-64 — `.git`-existence-only repo check (bare-skeleton safety)

**Optional** (reference as needed):
- planctl/store.py:230-250 — `get_actor` PLANCTL_ACTOR short-circuit
- The five `discover_projects` call sites listed in Approach — blast-radius verification
- tests/conftest.py:66-96 — `_git_global_config`: session-autouse prior art (runs once per xdist worker)

### Risks

- Discovery stub changes verb behavior at a call site that branches on
  non-empty discovery — verify each of the five sites; fall back to a
  narrower stub scope if any is behavior-sensitive.
- Dirty-probe stub shape breaks envelope `files`/`subject` assertions in
  non-real_git tests — the disk-walk fake mirrors the fresh-repo case;
  tests needing subtler dirty semantics belong in the slow bucket (task 2).
- Session-autouse fixtures run once per xdist worker — keep them
  setenv/monkeypatch-only (no subprocess, no file churn).

### Test notes

This task does NOT need the whole suite green — that is task 2's triage.
Prove the seams on a representative slice: test_claim (render stub),
test_set_snippets_bundles (roots + sketch stubs), test_envelope_shape
(dirty-probe stub), plus the new contract tests under `--run-slow`.
Capture a before/after spawn count for the slice (the subprocess-spy
one-liner from the epic investigation works).

## Acceptance

- [ ] All autouse stubs land in tests/conftest.py with marker opt-outs following the `_mock_autocommit` template
- [ ] `--run-slow` flag + collection hook skip the slow bucket by default (visible as skips); no `-m` expression in addopts
- [ ] New markers registered in `pytest_configure` (strict-markers clean)
- [ ] Contract tests exist for the render-spec and dirty-probe stubs and pass under `--run-slow`
- [ ] Representative fast-path slice runs with zero git/promptctl spawns (spy-verified)
- [ ] No changes under planctl/

## Done summary
Built the subprocess-free fast test gate: autouse conftest stubs (PLANCTL_ACTOR, brief render-spec, .planctl/ dirty-probe disk walk, empty roots discovery, sketch-refs, bare .git/ skeleton) with per-marker opt-outs, plus --run-slow + a skip-by-default collection hook that buckets real_git/integration/wire/real_promptctl tests as visible skips. New tests/test_stub_contracts.py pins the render-spec and dirty-probe stubs against the real binaries under --run-slow. Proof slice (test_set_snippets_bundles) spawns zero subprocesses; the broader-suite triage is task 2.
## Evidence
