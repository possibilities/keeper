## Description

**Size:** M
**Files:** planctl/run_find_task_commit.py (new), planctl/cli.py, tests/test_find_task_commit.py

Add a read-only `planctl find-task-commit <task_id>` verb that wraps the shipped `commit_lookup.find_commit_groups` and emits the keeper-compatible `{success: true, commits: [{sha, repo}]}` envelope the worker's predecessor-detection consumes.

### Approach

Copy `run_resolve_task.py` as the structural template (it is the closest read-only, task-keyed, `--project`-aware verb). Reuse its local `_emit_<verb>_error(code, message, *, details) -> NoReturn`, `_set_invocation_sentinel`, and `_context_for_root` helpers verbatim (these are duplicated per-verb by convention — do not try to share them). Flow: guard `planctl.ids.is_task_id(task_id)` → `BAD_TASK_ID` on failure; resolve the project via `find_projects_with_task` (with the `--project <abs>` escape + `AMBIGUOUS_TASK_ID` / `TASK_NOT_FOUND` / `NOT_A_PROJECT` typed errors, exactly as resolve-task); derive the epic id with `planctl.ids.epic_id_from_task(task_id)` (AFTER the `is_task_id` guard, so its `ValueError` path is unreachable); load `epic_def` and compute `primary_repo = str(Path(epic_def.get("primary_repo") or ctx.project_path).resolve())` and `touched_repos = epic_def.get("touched_repos")` (mirror close-preflight). Call `find_commit_groups([task_id], primary_repo, touched_repos)`. FLATTEN the grouped `[{repo, shas}]` to `commits = [{"sha": sha, "repo": repo} for group in groups for sha in group["shas"]]` (preserves repo-outer first-seen + per-repo grep order; SHAs already deduped by the module). Emit `{"commits": commits}` via `emit(payload, planctl_invocation=build_planctl_invocation_readonly("find-task-commit", task_id, repo_root=ctx.project_path))` — `emit` wraps `success: true`. Catch `AllReposBrokenError` → `_emit_*_error("COMMIT_LOOKUP_FAILED", ..., details={"broken_repos": exc.broken_repos})` (nonzero exit, sentinel set). A clean miss is `find_commit_groups` returning `[]` → `{success: true, commits: []}` exit 0 (NEVER an error). Register in `cli.py` with `@cli.command("find-task-commit")` + `@click.argument("task_id")` + the `--project` option + `@agent_help_option(_FIND_TASK_COMMIT_AGENT_HELP)` + the `_lazy_import("planctl.run_find_task_commit")(...)` wiring (mirror the close-preflight registration, which carries agent-help; resolve-task lacks it). Keep the verb OUT of `_NO_TRACK_COMMANDS` so the readonly invocation trailer rides (like resolve-task). Do NOT port keeper's `--repos` / `--max-count` flags — no caller uses them and `find_commit_groups` exposes no `max_count`.

### Investigation targets

**Required** (read before coding):
- planctl/run_resolve_task.py — the copy template: error helpers, sentinel, `_context_for_root`, `find_projects_with_task` resolution, `--project` handling, `epic_id_from_task` use, the read-only-no-commit test
- planctl/run_close_preflight.py:119-147,205-216 — the `find_commit_groups` call + `AllReposBrokenError`→`COMMIT_LOOKUP_FAILED(details=broken_repos)` mapping + how `primary_repo`/`touched_repos` are loaded from `epic_def`
- planctl/commit_lookup.py:185-244 — `find_commit_groups` signature + grouped return shape + `AllReposBrokenError`; the SHA-dedup-within-repo and `touched_repos` tri-state behavior the wrapper inherits
- planctl/ids.py:76,82 — `is_task_id`, `epic_id_from_task`
- planctl/cli.py:18 (`_NO_TRACK_COMMANDS`), the close-preflight registration (`@agent_help_option`) and resolve-task registration
- planctl/invocation.py — `build_planctl_invocation_readonly`

**Optional** (reference as needed):
- tests/test_resolve_task.py — `_roots_at_tmp_project` autouse, `_first_envelope`, read-only-no-commit assertion, `--project` disambiguation
- tests/test_close_preflight.py:104-130 — `_seed_commit(repo, task_id, body=)`, `_envelope`

### Risks

- **Envelope byte-compat:** the success shape (`{success:true, commits:[{sha,repo}]}`, field names `sha`/`repo`, full `%H`) must match what close-preflight/the worker expect. Empty result = success exit 0; all-broken = error exit 1 — never conflate.
- **Resolution-model choice:** this uses planctl's roots/`find_projects_with_task` + `epic_def` model (the accepted contract), NOT keeper's cwd-walk-up. The worker runs from inside the repo so cwd≈primary; document the model in agent-help.
- **Invocation trailer:** the verb emits a 2nd NDJSON `planctl_invocation` line after the data envelope (staying out of `_NO_TRACK_COMMANDS`). Task 2 verifies the worker template consumes the first envelope tolerantly.

### Test notes

`tests/test_find_task_commit.py` (copy `_roots_at_tmp_project` autouse + `_first_envelope` from test_resolve_task; `_seed_commit` from test_close_preflight; fixtures `planctl_git_repo` / `multi_repo_project` / `seed_epic`): single-task happy path (real `Task:`-trailer commit → flat `commits:[{sha,repo}]`), flatten correctness + order, clean-miss empty success exit 0, prose-false-match dropped (via `_seed_commit(body=...)`), `AllReposBrokenError`→`COMMIT_LOOKUP_FAILED`+`details.broken_repos` exit 1, `BAD_TASK_ID` on a non-task id, `--project` resolution, read-only-no-commit (HEAD unchanged, no `find-task-commit` subject in git log).

## Acceptance

- [ ] `planctl find-task-commit <task_id>` emits `{success:true, commits:[{sha,repo}]}` (full `%H`) for a trailer-carrying commit; clean miss → empty success exit 0
- [ ] `AllReposBrokenError` → `COMMIT_LOOKUP_FAILED` typed error envelope with `details.broken_repos`, nonzero exit
- [ ] typed `BAD_TASK_ID` / `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `NOT_A_PROJECT` errors via the resolve-task resolution path; `--project` escape works
- [ ] verb is read-only (HEAD unchanged, no commit), rides the readonly invocation footer, OUT of `_NO_TRACK_COMMANDS`
- [ ] `--repos`/`--max-count` intentionally omitted; `_FIND_TASK_COMMIT_AGENT_HELP` documents the envelope + typed errors
- [ ] `uv run pytest tests/test_find_task_commit.py`, `uv run ty check`, `uv run ruff check .` clean

## Done summary

## Evidence
