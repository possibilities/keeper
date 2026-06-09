## Description

**Size:** M
**Files:** planctl/commit_lookup.py (new), planctl/run_close_preflight.py, tests/test_close_preflight.py, pyproject.toml, uv.lock, planctl/cli.py, skills/close/SKILL.md

Replace the `keeper find-task-commit` subprocess in `run_close_preflight._commit_groups` with a native in-process git scan housed in a new shared module `planctl/commit_lookup.py`, then prune the now-dead `keeper-py` dependency and rewrite the four stale docstrings/doc-lines. The planctl Python package ends with zero `keeper` coupling while `close-preflight`'s envelope stays byte-identical for the `/plan:close` quality-auditor.

### Approach

Build `planctl/commit_lookup.py` as a shared, verb-agnostic module (sits alongside `commit.py` / `ids.py`; not a `run_*` verb). It exposes a function that takes the resolved task ids + the resolved-absolute `primary_repo` + the epic's `touched_repos`, and returns the grouped result — it does NOT call `output.emit`, `auto_commit`, or `sys.exit` (so `fn-6`'s `run_reconcile.py` can import it cleanly). On an all-repos-broken condition it raises a typed exception (e.g. `AllReposBrokenError(broken_repos=[...])`); `run_close_preflight._commit_groups` catches it and maps to the existing `_emit_preflight_error("COMMIT_LOOKUP_FAILED", ..., details={"broken_repos": [...]})`. A clean miss (no matching commit) is a normal empty result, never an error.

The scan, per the reference impl (`../keeper/cli/find-task-commit.ts`, `trailers.ts`):
1. Resolve the repo set from `touched_repos` tri-state: `None`/absent -> `[primary_repo]` (the line-236 resolved abs path); `[]` -> scan nothing, return empty (do NOT collapse to primary_repo); non-empty -> each entry resolved to an absolute path. Skip an entry whose path is missing or not a git repo, emitting a stderr note; raise `AllReposBrokenError` only when EVERY listed entry is broken.
2. Per repo (outer loop), per task id (inner loop): `git log --grep="Task: <task_id>" -F --pretty=format:%H` (cwd=repo). `-F` is fixed-string, so NO `^`/`$` anchors. This is a loose pre-filter.
3. Per candidate SHA: `git log -1 --format=%B <sha>` (cwd=repo) piped via `input=` (stdin, no temp file) to `git interpret-trailers --parse`. Parse the output into `dict[str, list[str]]` (multi-valued keys), splitting each line on the first `":"` then stripping both sides; empty/whitespace-only parse output = no trailers. Confirm membership: a value in `trailers.get("Task", [])` that equals `<task_id>` AND passes `planctl.ids.is_task_id`. This post-filter is what drops prose false-matches.
4. Group confirmed `{sha, repo}` into `[{repo, shas: [...]}]` in repo-outer first-seen order (= `touched_repos` order). Dedup SHAs within a repo group (guards a commit carrying two `Task:` trailers or a repo listed twice).

Subprocess hygiene (match `planctl/commit.py` + practice-scout): `subprocess.run([...], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)` — never `shell=True`; manual `returncode` check. Validate each `task_id` with `is_task_id` before building argv (defense-in-depth). Use full `%H` SHAs (keeper parity).

Then rewire `run_close_preflight.run()` (call site ~254) to pass the already-loaded `epic_def`-derived `touched_repos` + `primary_repo`; delete the keeper subprocess from `_commit_groups`.

Prune `keeper-py`: remove it from `pyproject.toml` `dependencies` (line 6), delete the `[tool.uv.sources]` block (lines 11-16) and the `[tool.ty.analysis]` `allowed-unresolved-imports` block (lines 60-66), then run `uv lock` (do NOT hand-edit `uv.lock`; keeper-py appears at lines 81/101/118).

Rewrite all four stale references present-tense (CLAUDE.md no-backward-facing-advice rule — describe the native scan as the present fact, never "formerly shelled keeper"): `run_close_preflight.py` module docstring (lines 19-23), `_commit_groups` docstring (lines 116-125), `planctl/cli.py:551-562` close-preflight command docstring, and `skills/close/SKILL.md:57`.

### Investigation targets

**Required** (read before coding):
- `planctl/run_close_preflight.py:116-170` — `_commit_groups` being replaced; `run()` lines 235-254 already resolve `epic_def`, `primary_repo`, task ids
- `planctl/run_close_preflight.py:41-61` — `_emit_preflight_error` (NoReturn, sys.exit 1); the native module must NOT call this — the verb does
- `planctl/run_worker_resume.py:42-69` — `_find_source_commit_sha`, the existing `git log --grep ... --fixed-strings` idiom to generalize
- `planctl/ids.py:11-13,76-79` — `ID_REGEX` / `is_task_id`, the mandated trailer-value validator (looser than keeper's `TASK_TRAILER_RE` by design)
- `planctl/models.py:69-72` — `normalize_epic` defaults `primary_repo` and `touched_repos` to `None`
- `planctl/commit.py` — canonical planctl git-subprocess idiom (capture/encoding/manual returncode)
- `tests/test_close_preflight.py:75-102,177-210` — `_fake_invoke` (dispatches on `cmd[:2]`), `test_groups_by_repo`, `test_keeper_failure_is_fail_loud`
- `tests/conftest.py` — `real_git` marker, `multi_repo_project` / `planctl_git_repo` fixtures, autouse hermetic `_git_global_config`

**Optional** (reference as needed):
- `../keeper/cli/find-task-commit.ts`, `../keeper/src/commit-work/trailers.ts` — the parity blueprint
- `pyproject.toml:6,11-16,60-66` and `uv.lock:81,101,118` — the prune targets

### Risks

- **Envelope contract**: `commit_groups: [{repo, shas}]` + `COMMIT_LOOKUP_FAILED` are consumed verbatim by the `/plan:close` auditor (`skills/close/SKILL.md:57,65,67`). Keep keys byte-identical; `repo` values must be resolved absolute paths.
- **First-seen order**: group order now derives from the repo-outer loop (= `touched_repos` order), not keeper's output order. Pin the loop nesting; seed test commits so the asserted order is unambiguous.
- **Fail-loud semantics shift**: the old per-task-subprocess "first failure aborts" becomes "all-repos-broken aborts" (single-pass over the epic-level repo set). `test_keeper_failure_is_fail_loud` is rewritten accordingly (new `details.broken_repos` shape), not preserved verbatim.
- **fn-6 reuse seam**: the module's public API (return-data / raise-typed-exception, no emit/exit) is the load-bearing contract fn-6.1 will import. Get it right here.

### Test notes

Replace the `_fake_invoke` keeper branch. Prefer the `real_git` marker + `multi_repo_project` fixture for the grouping/order/happy-path tests (real commits carrying real `Task:` trailers — hermetic and deterministic via the autouse git config); use a controllable broken/missing repo dir for the all-repos-broken fail-loud test. Add direct unit tests for `commit_lookup.py`: clean miss -> empty, prose false-match dropped by the trailer post-filter, `is_task_id`-rejected trailer value dropped, multi-valued `Task:` keys, `touched_repos` tri-state (`None` / `[]` / non-empty-with-one-broken), SHA dedup. Keep the `promptctl render-spec` test branch and the existing `SNIPPET_RENDER_FAILED` path untouched.

## Acceptance

- [ ] `planctl/commit_lookup.py` exists; performs the native `git log --grep` + `interpret-trailers --parse` scan; returns grouped `[{repo, shas}]`; raises a typed all-repos-broken exception; never calls `emit`/`auto_commit`/`sys.exit`
- [ ] `run_close_preflight._commit_groups` consumes the module; no `keeper` subprocess remains in `planctl/`
- [ ] `close-preflight` envelope (`commit_groups` shape, first-seen grouping, `COMMIT_LOOKUP_FAILED` with `details.broken_repos`) verified by the rewired tests
- [ ] `touched_repos` tri-state, prose false-match drop, `is_task_id` post-filter, multi-valued keys, and SHA dedup covered by unit tests
- [ ] `keeper-py` removed from `pyproject.toml` (dependencies + `[tool.uv.sources]` + `[tool.ty.analysis]`) and `uv.lock` via `uv lock`
- [ ] four stale `keeper find-task-commit` docstrings/doc-lines rewritten present-tense; worker-runbook references (`skills/work/SKILL.md`, `commit-at-mutation-boundary.md:468`) untouched
- [ ] `uv run pytest tests/`, `uv run ty check`, `uv run ruff check .`, `uv run ruff format .` all clean

## Done summary
Replaced the keeper find-task-commit subprocess in close-preflight with a native in-process git trailer scan in a new planctl/commit_lookup.py module (verb-agnostic, returns grouped [{repo,shas}] or raises AllReposBrokenError), pruned the dead keeper-py dependency, and rewrote four stale doc-lines present-tense. The close-preflight envelope stays byte-identical for the /plan:close auditor.
## Evidence
