## Description

**Size:** S
**Files:** planctl/run_init.py, planctl/commit_messages.py, tests/test_init.py, docs/reference/commit-at-mutation-boundary.md, CLAUDE.md, README.md

Make `planctl init` self-commit the `.planctl/` bootstrap files it writes,
without any `CLAUDE_CODE_SESSION_ID` dependency, and update the contract docs
that currently assert every mutating verb is session-id-keyed.

### Approach

In `planctl/commit_messages.py`, register `"init"` in `VERB_TEMPLATES`
(`"init": lambda t, d: _subject("init", t, d)`) with an inline comment noting
`init` is the mutating verb that builds its own payload directly, without the
touched-paths log or `CLAUDE_CODE_SESSION_ID`. Do NOT add `init` to
`VALIDATION_RESTAMP_VERBS` — it mints no epic.

In `planctl/run_init.py`, track which repo-relative POSIX paths each write
path actually creates this invocation: have `_ensure_advice_files` return the
list of advice files it created; the fresh-init branch adds `.planctl/meta.json`
and `.planctl/.gitignore`; the backfill branch contributes only the advice
files it created (often none). Then:

- If the written list is non-empty AND the cwd is inside a git work tree,
  build the payload literal — `{files: sorted(written), op: "init",
  target: project_root.name, subject: build_subject("init", project_root.name),
  touched_path_files: [], repo_root: str(project_root),
  state_repo: str(project_root), queue_jump: False}` with NO `session_id`
  key — and call `emit(project_data, planctl_invocation=payload)`. `emit`
  runs the auto-commit, prints the structured `commit_failed` envelope +
  exit 1 on `CommitFailed`, and sets the dedup sentinel so the
  `InvocationTrackedGroup` decorator does not also emit a read-only line.
- Otherwise (nothing written, or not in a git work tree) call plain
  `emit(project_data)` — the existing read-only path. This keeps `init`
  working in a fresh non-git `/tmp` dir and keeps idempotent re-runs from
  producing empty commits.

The git-work-tree check should reuse an existing helper if one exists
(search `planctl/commit.py`, `planctl/project.py`); otherwise a
`git rev-parse --is-inside-work-tree` subprocess in `project_root` is fine.
`init` must NOT call `build_planctl_invocation` (that is the path that
raises on a missing session id and discovers files via the touched-paths
log) — build the payload dict directly.

Update the contract docs to state the present-tense fact (no backward-facing
phrasing per the project CLAUDE.md doc rule):
- `docs/reference/commit-at-mutation-boundary.md`: add an `init` row/note to
  the §3 verb classification, add the `chore(planctl): init <project-name>`
  subject example in §5, and revise §12 to name `init` as the verb that
  builds its own invocation payload without the session-id requirement.
- `CLAUDE.md`: add the carve-out in the "Commit behavior" bullet (init builds
  its payload directly, no touched-paths log, no session-id requirement) and
  in the "Session id" section (init does not route through
  `build_planctl_invocation`).
- `README.md`: qualify the auto-commit and `CLAUDE_CODE_SESSION_ID` notes so
  `init` is named as the session-id-free mutating verb.

### Investigation targets

**Required** (read before coding):
- planctl/run_init.py:34-76 — current init: writes + the two `emit(project_data)` call sites (fresh + backfill)
- planctl/run_validate.py:107-149 — precedent for a verb that builds a payload and commits outside the `verb=` path (fallback shape if the emit route fails)
- planctl/output.py — `emit()` pre-built `planctl_invocation=` branch: auto-commit, `commit_failed` envelope, sentinel set
- planctl/commit.py — `auto_commit_from_invocation` (payload fields consumed, dirty re-confirm, `Session-Id` trailer fail-open) + `CommitFailed`
- planctl/invocation.py:43-137 — `build_planctl_invocation`: the session-id-raising path to avoid + the exact payload field shape to mirror
- planctl/commit_messages.py — `VERB_TEMPLATES` + `build_subject` (the registry entry and the comment style of existing entries)
- tests/conftest.py — `project` / `planctl_git_repo` fixtures and `_git_global_config` (hermetic commits; both currently set `CLAUDE_CODE_SESSION_ID`)

**Optional** (reference as needed):
- planctl/cli.py:18-89 — `_NO_TRACK_COMMANDS` + `InvocationTrackedGroup` (confirm the sentinel dedups; init should NOT need to join the no-track set)
- planctl/store.py — `atomic_write_json` (already used for meta.json)

### Risks

- The backfill branch must contribute only files it actually wrote, or a
  no-op re-run would attempt a commit; the dirty re-confirm makes an empty
  list a no-op, but the `written`-tracking must be accurate to avoid a
  spurious mutating envelope on a clean re-run.
- The `AGENTS.md` symlink must be stage-able by path (`git add -- .planctl/AGENTS.md` stages the link itself — verified by repo-scout).
- Doc edits must not introduce backward-facing phrasing (project CLAUDE.md rule).

### Test notes

Add a test in `tests/test_init.py` that runs `init` with
`CLAUDE_CODE_SESSION_ID` unset (`monkeypatch.delenv(..., raising=False)`) in a
git repo and asserts: exit 0; a `chore(planctl): init <name>` commit landed;
the bootstrap files are tracked in HEAD; the working tree is clean; and the
commit message carries no `Session-Id:` trailer. Keep/extend the existing
idempotency test to assert a no-write re-run creates no new commit.

## Acceptance

- [ ] `"init"` is registered in `VERB_TEMPLATES`; `init` is NOT in `VALIDATION_RESTAMP_VERBS`
- [ ] `planctl init` in a git repo commits exactly the bootstrap files it wrote; the working tree is clean afterward and the subject is `chore(planctl): init <project-name>`
- [ ] `init` runs with `CLAUDE_CODE_SESSION_ID` unset — no `RuntimeError`, no env-var reference on the init path; the commit has no `Session-Id:` trailer
- [ ] An idempotent re-run that writes nothing produces no commit; `init` in a non-git dir still writes files and exits 0 without a commit
- [ ] `commit-at-mutation-boundary.md`, `CLAUDE.md`, and `README.md` describe `init` as the session-id-free mutating verb, in present-tense phrasing
- [ ] `uv run pytest tests/test_init.py`, `uv run ruff check .`, and `uv run ty check` pass

## Done summary

## Evidence
