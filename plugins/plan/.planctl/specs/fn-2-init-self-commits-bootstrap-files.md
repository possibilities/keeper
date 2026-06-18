## Overview

`planctl init` writes a `.planctl/` bootstrap set (`meta.json`, `.gitignore`,
`CLAUDE.md`, and the `AGENTS.md` symlink) but emits via the read-only `emit()`
path, so those files are left untracked in the working tree. This epic makes
`init` self-commit its bootstrap files the same way other mutating verbs do —
landing a `chore(planctl): init <project-name>` commit — while staying free of
any `CLAUDE_CODE_SESSION_ID` dependency. The session id is only needed by
variable-file verbs that discover their commit set through the touched-paths
log; `init` writes a fixed, known set, so it builds its own
`planctl_invocation` payload with an explicit file list and hands it to
`emit(planctl_invocation=...)`. End state: a fresh `planctl init` in a git
repo leaves a clean working tree with the bootstrap files committed.

## Quick commands

- `d=$(mktemp -d) && git -C "$d" init -q && (cd "$d" && env -u CLAUDE_CODE_SESSION_ID planctl init >/dev/null && git status --porcelain && git log --oneline -1)` — init with no session id leaves a clean tree and a `chore(planctl): init` commit
- `uv run pytest tests/test_init.py` — init test suite passes

## Acceptance

- [ ] `planctl init` in a git repo commits the bootstrap files it writes; the working tree is clean afterward
- [ ] The commit subject is `chore(planctl): init <project-name>` with no `Session-Id:` trailer
- [ ] `init` works with `CLAUDE_CODE_SESSION_ID` unset (no `RuntimeError`, no reference to the env var on the init path)
- [ ] An idempotent re-run that writes nothing produces no commit (no empty commit)
- [ ] The commit contract docs (commit-at-mutation-boundary.md, CLAUDE.md, README.md) accurately describe `init` as the session-id-free mutating verb

## Early proof point

Task that proves the approach: `.1`. If it fails (e.g. the explicit-payload
route still drags in a session-id dependency, or empty re-runs create commits):
fall back to copying `run_validate.py`'s manual `auto_commit_from_invocation`
try/except block instead of the `emit(planctl_invocation=...)` route.

## References

- `docs/reference/commit-at-mutation-boundary.md` — authoritative commit-at-mutation-boundary contract (the doc that must stay accurate)
- `planctl/run_validate.py:107-149` — established precedent for a verb that builds its own payload and commits outside the `verb=` path
- `planctl/output.py` `emit()` — pre-built `planctl_invocation=` path: runs auto-commit, prints the failure envelope on `CommitFailed`, and sets the dedup sentinel
- `planctl/commit.py` `auto_commit_from_invocation` — re-confirms each path against the git dirty set (listing an already-clean path is a harmless no-op) and omits the `Session-Id:` trailer when `session_id` is falsy

## Best practices

- **No `--allow-empty` / no empty commits:** an empty commit from automation is a bug; the dirty re-confirm in `auto_commit_from_invocation` already short-circuits a no-write re-run. [practice-scout: lint-staged]
- **Pathspec-scoped, explicitly-staged commit:** never `git add .` / `git commit -a` in a bootstrap path; commit exactly the known file list. [practice-scout: git-commit(1)]
