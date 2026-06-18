## Description

**Size:** M
**Files:** tests/conftest.py

### Approach

Build the single invoker every test will route through. Extend `_CliResult` with `.exit_code` (alias of returncode) and `.output` (stdout+stderr merged, matching CliRunner's mix_stderr default) alongside the existing `returncode`/`stdout`/`stderr`. Introduce one module-level invoker (signature like `run_cli` today: args, cwd, env, input_text) with two engine bodies: default — drive `cli.main(..., standalone_mode=False)` in-process exactly as `run_cli` does now; conformance (active when `PLANCTL_BIN` is set) — `subprocess.run([PLANCTL_BIN, *args], ...)` with a minimal explicit env dict: per-worker session-scoped tmp HOME (covers `~/.config/planctl/config.yaml`, `~/.local/state/planctl/sessions`, and the epic-id flock — all expanduser-resolved by a fresh interpreter), XDG_* pointed under that HOME, GIT_CONFIG_GLOBAL → an empty temp file, GIT_CONFIG_SYSTEM=/dev/null, PATH, PLANCTL_ACTOR, plus per-call test-supplied env. Fail fast at session start if `PLANCTL_BIN` is set but missing or not executable. Under conformance: the four autouse isolation stubs early-return (the `_mock_autocommit` marker-check template, keyed on the env signal); `project`/`planctl_git_repo`/`multi_repo_project` take their real-git branch suite-wide; roots discovery is isolated automatically (tmp HOME has no config.yaml → default `~/code` resolves under tmp HOME → empty scan). Convert `run_cli` into a thin wrapper of the new invoker and route the shared seed helpers (`project`'s seeding, `seed_epic`, `add_task`, `multi_repo_project`'s inline invoke) through it. `seed_state` stays in-process by design (CLI-free disk builder) — conformance-neutral, leave it alone.

### Investigation targets

**Required** (read before coding):
- tests/conftest.py:412-477 — `run_cli` + `_CliResult`, the seam being generalized
- tests/conftest.py:291-409 — `project`, `planctl_git_repo`, `multi_repo_project` fixtures and their real_git branching
- tests/conftest.py:546-657 — `seed_epic`, `seed_state` (the latter stays untouched)
- tests/conftest.py:728-758 — `add_task` helper with inline CliRunner
- tests/conftest.py:119-235 — the autouse stubs gaining the conformance early-return
- tests/test_generated_guard_hook.py:437-512 — cross-process HOME-isolation env precedent

**Optional** (reference as needed):
- tests/conftest.py:238-260 — `_git_global_config` session fixture (interplay with GIT_CONFIG_GLOBAL in the subprocess env)
- tests/conftest.py:760-786 — `parse_cli_output` (already subprocess-safe; do not duplicate)

### Risks

`.output` semantics differ subtly between engines: CliRunner interleaves stdout/stderr as produced; subprocess capture concatenates two separately-captured streams. Substring asserts survive; any interleaving-order-sensitive assert may not — surface such tests rather than papering over. This task is the epic's early proof point: if unification fights back, the scoped retreat is keeping `run_cli` subprocess-only and converting files incrementally.

### Test notes

Prove both engines through the seam itself: a handful of representative verbs (init, scaffold, claim, done) green via the invoker in default mode AND with `PLANCTL_BIN` pointed at the installed Python planctl. Verify the fast gate's wall-clock is unchanged (no subprocess spawn on the default path).

## Acceptance

- [ ] One invoker with both engine bodies exists in conftest; result object exposes returncode/stdout/stderr/exit_code/output
- [ ] `PLANCTL_BIN` set ⇒ subprocess engine with the minimal env dict and per-worker tmp HOME; set-but-broken ⇒ fail-fast session error; unset ⇒ in-process engine, zero behavior change
- [ ] The four autouse isolation stubs early-return under conformance; fixtures force the real-git branch suite-wide under conformance
- [ ] `run_cli` and the shared seed helpers route through the invoker; `seed_state` untouched
- [ ] Default fast gate green and as fast as before; a representative conformance subset green against the installed Python planctl

## Done summary
Unified run_cli into one invoker with in-process and subprocess engines dispatched on PLANCTL_BIN; _CliResult gains exit_code/output, the four autouse stubs early-return under conformance, fixtures force real git, and the minimal per-worker tmp-HOME env makes the suite xdist-viable. Representative conformance subset (init/scaffold/claim/validate/envelope) green against the installed Python planctl; fast gate unchanged.
## Evidence
