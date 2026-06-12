## Description

**Size:** M
**Files:** src/invocation.ts, src/commit.ts (new), src/cli.ts, test/ additions

### Approach

The committing seam. buildPlanctlInvocation (mutating): session id fail-CLOSED (throw when CLAUDE_CODE_SESSION_ID absent), touched_path_files from the record files, files = sorted intersection of touched-paths content with the dirty probe `git status --porcelain --untracked-files=all -- .planctl/` parsed exactly as Python does (line[3:], rename "a -> b" takes b; no -z, no parsing improvements), field order files/op/target/subject/touched_path_files/repo_root/state_repo/queue_jump/session_id, path-traversal rejection on touched content. autoCommitFromInvocation in src/commit.ts: empty files → null no-op (never an empty commit); missing state_repo → repo_root fallback with stderr warn, else typed failure; per attempt (max 8, full-jitter backoff base 0.1s cap 2.0s): pathspec dirty check (empty → null), rev-parse HEAD with "unknown" sentinel on fresh repos, git add -- <dirty>, git commit -F - -- <dirty> with the message on stdin, rev-parse for the returned sha; retry ONLY on contention stderr (index.lock / File exists / cannot lock ref); message = `chore(planctl): <op> <target>` + blank line + Planctl-Op/Planctl-Target/Planctl-Prev-Op trailers + Session-Id only when present. Git spawns: Bun.spawnSync with explicit cwd, inheriting the ambient env untouched (GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/PLANCTL_*/CLAUDE_CODE_SESSION_ID ride through; never set GIT_DIR/GIT_WORK_TREE, never substitute a sanitized env). Mutating emit path in cli.ts: build envelope → build invocation (throws surface verbatim) → commit BEFORE printing → on failure print ONE compact line {"success":false,"error":"commit_failed","details":...,"planctl_invocation":...} and exit 1 with the success envelope unprinted → on success embed the invocation and print ONE compact line. Ensure the mutating path never double-prints the read-only trailer. Bun units port tests/test_commit.py's assertions (commit counts, sha shape, trailer presence/absence, file lists, no-op paths) against real git tmp repos.

### Investigation targets

**Required** (read before coding):
- planctl/invocation.py:43-137 and :215-243 — the builder and dirty probe, exact parsing
- planctl/commit.py:204-262 and :270-399 — retry classification, message body, attempt loop
- planctl/output.py:22-152 — emit ordering and CommitFailed envelope shape
- tests/test_commit.py — the assertion set to port into bun units
- src/cli.ts — landed dispatch/trailer machinery being extended

**Optional** (reference as needed):
- planctl/commit_messages.py:22-28 — subject construction
- tests/conftest.py:580-613 — what env the conformance harness forwards (the reason env must pass through)

### Risks

Over-sanitizing the git env is the classic failure here — the harness's GIT_CONFIG_GLOBAL carries committer identity and gpgsign/hooks config; stripping it makes every conformance commit fail or diverge. Retry classification must match Python's stderr substrings exactly or contention behavior diverges under concurrent engines.

### Test notes

bun units green against real git incl. fresh-repo "unknown" prev-sha and contention-retry classification; lint/typecheck green.

## Acceptance

- [ ] Mutating envelope is one compact line with embedded invocation; CommitFailed shape and exit-1 path match Python
- [ ] Commit subjects and trailer bodies byte-identical to Python for identical inputs; Session-Id omitted (not empty) when absent
- [ ] Dirty probe + intersection reproduce Python's parsing; --untracked-files=all present
- [ ] tests/test_commit.py assertion set represented in bun units

## Done summary

## Evidence
