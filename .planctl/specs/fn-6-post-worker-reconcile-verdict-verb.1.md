## Description

**Size:** M
**Files:** planctl/run_reconcile.py (new), planctl/cli.py, tests/test_reconcile.py

Add the read-only `planctl reconcile <task_id>` verb — the keystone. It returns a typed post-worker verdict computed entirely from planctl-native data (status, git source commits, HEAD-visibility, epic tally). No keeper call, no mutation, no commit.

### Approach

Model the verb on `run_resolve_task.py`: validate the id (`is_task_id`), resolve the owning project cwd-agnostically (lift `_resolve_project_for_task` — the resolve-task variant, no claimable filter — with a `--project` override), load the task def + epic def, compute fields, then `emit({...}, planctl_invocation=build_planctl_invocation_readonly("reconcile", task_id, repo_root=ctx.project_path))`. Register in `cli.py` top-level (lazy import) exactly like `resolve-task`. Bad/missing/ambiguous id → typed error envelope (exit 1, suppress the readonly footer via the sentinel) mirroring resolve-task's `BAD_TASK_ID`/`TASK_NOT_FOUND`/`AMBIGUOUS_TASK_ID`/`NOT_A_PROJECT`.

**Signals → verdict TRUTH TABLE** (the load-bearing artifact; pin it in code + an exhaustiveness test):
- `merge_task_state` status `done` AND `worker_done_at` visible in `HEAD:<task.json>` → **`done`**
- status `done` AND `worker_done_at` NOT in HEAD → **`state_uncommitted`** (auto-commit failed; fix is a re-run of `planctl done`)
- status `in_progress` AND a trailer-authentic `Task: <id>` commit exists → **`in_progress_committed`**
- status `in_progress` AND no such commit → **`in_progress_uncommitted`**
- status `blocked` → **`blocked`** (carry `blocked_reason`)
- status `todo` → **`not_started`**
- any git subprocess failure (missing binary / not a repo / unexpected non-zero) → **`tooling_error`** (fail-closed; NEVER silently `not_started`/`done`)

**Source commits (trailer-authentic, NOT substring):** do NOT import `_find_source_commit_sha` (substring matcher; fn-5 is concurrently rewriting `run_worker_resume.py`). Build a self-contained finder (a small new helper in `run_reconcile.py` or a tiny git helper module) that lists candidate commits and confirms a REAL `Task:` trailer whose value EXACTLY equals `<task_id>` — via `git log --format='%H%x1f%(trailers:key=Task,valueonly=true)'` parsed in Python, or `--grep` pre-filter + `git interpret-trailers --parse` confirm. This kills the prose false-match AND the `fn-5.1`/`fn-5.10` substring collision. Scan the task's `target_repo` (`_expected_worker_cwd`), falling back to every `epic.touched_repos` entry, else `primary_repo`. Report all matching SHAs as `source_commits: [{sha, repo}]`.

**state_head_visible (distinct cwd!):** run `git cat-file -e HEAD:<relpath>` where `<relpath>` is `.planctl/tasks/<id>.json` repo-root-relative to **`state_repo`** (`epic.primary_repo` falling back to `repo_root` — commit.py:313-329), NOT `target_repo`, NOT cwd, no leading slash. Guard the unborn-branch case first (`git rev-parse --verify HEAD`, exit 128 → distinct no-commits signal, not `tooling_error`). `state_uncommitted` means the committed task JSON in HEAD lacks `worker_done_at` (or the path isn't in HEAD) while the on-disk merged status is `done` (the runtime sidecar is gitignored and never in HEAD — check `worker_done_at` on the TRACKED task JSON, per run_done.py:124-143). Add a `cat-file`/`rev-parse` helper mirroring `_current_head` (commit.py:65).

**epic_progress (reporting-only):** `{done, total}` by filtering `tasks_dir.glob("*.json")` to this epic's task ids and reusing the `merge_task_state`+tally loop (run_status.py:33-52 / run_epics.py). It is NOT a verdict input (not in the truth table) — purely a Phase-5 reporting field. Reconcile NEVER calls `validate --epic` (that is conditionally-mutating; would break read-only). Degrade gracefully if epic.json is missing.

Envelope: `{verdict, task_id, epic_id, status, source_commits, state_head_visible, epic_progress: {done, total}, assessed_at, blocked_reason|null}`.

### Investigation targets

**Required**:
- planctl/run_resolve_task.py — the read-only-verb template (resolve, error envelope, readonly invocation, sentinel).
- planctl/run_worker_resume.py:42-69 — the existing substring `_find_source_commit_sha` (pattern reference; do NOT import) and lines 124-133 (target_repo vs state_repo/primary_repo split).
- planctl/run_done.py:124-143 — `done` writes the sidecar `status:done` then stamps `worker_done_at` on the tracked task JSON then auto-commits — the `state_uncommitted` predicate origin.
- planctl/commit.py:65-78 (`_current_head` to mirror), 313-329 (`state_repo` precedence).
- planctl/models.py:25 (`TASK_STATUSES`), 112-127 (`normalize_task`, `worker_done_at` default null), 160 (`merge_task_state`).
- planctl/run_status.py:33-52 — the glob+merge+tally loop to filter-and-reuse for `epic_progress`.
- planctl/run_claim.py:188-271 — `_expected_worker_cwd` (target_repo) + primary_repo resolution.
- planctl/cli.py — the `resolve-task` registration block to mirror.
- tests/test_resolve_task.py — no-commit assertion (rev-parse HEAD before/after equal) + readonly-footer assertion (op/subject/files).

**Optional**:
- tests/test_work_skill_consistency.py — Group A parses `planctl <verb>` from the work template; `planctl reconcile --help` must exit 0 (this task delivers that; task `.3` references the verb).

### Risks

- **target_repo vs state_repo conflation** — the #1 correctness trap; source scan in target_repo, cat-file in state_repo. Test a cross-repo task fixture if feasible.
- **Substring/prose trailer false-match** — must be exact-trailer; test `fn-5.1` does NOT match a `fn-5.10` commit and a prose "Task: <id>" body line does NOT count.
- **Fail-closed** — a git failure must yield `tooling_error`, never a clean verdict. The reused substring helper's None-on-failure swallow is WRONG here.
- **StrEnum** — use only if project min Python ≥3.11 (the codebase references it elsewhere; verify), else `str, Enum` with explicit `.value` serialization.

### Test notes

`tests/test_reconcile.py` (model on test_resolve_task.py): one test per verdict (seed the matching state + git history), the bad-id error envelope, the no-commit assertion (HEAD unchanged), the readonly-footer assertion (`op=="reconcile"`, subject/files None), the trailer-authenticity cases (prose body, `fn-5.1`/`fn-5.10` collision), the unborn-branch guard, and the exhaustiveness test (every verdict member maps to a handler / is covered). Confirm `planctl reconcile --help` exits 0.

## Acceptance

- [ ] `planctl reconcile <task_id>` registered top-level; `--help` exits 0; read-only (no commit, NULL subject/files, never calls a mutating verb or validate).
- [ ] Returns the verdict envelope per the truth table; all 7 verdicts reachable and tested; bad/missing/ambiguous id → typed error envelope (exit 1).
- [ ] Source-commit detection is trailer-exact (no prose / no `fn-5.1`↔`fn-5.10` collision), scans target_repo/touched_repos; `state_head_visible` cat-files against state_repo with the unborn-branch guard.
- [ ] `epic_progress` is reporting-only (not a verdict input); `tooling_error` is fail-closed.
- [ ] `tests/test_reconcile.py` green (incl. exhaustiveness); ruff + ty clean.

## Done summary

## Evidence
