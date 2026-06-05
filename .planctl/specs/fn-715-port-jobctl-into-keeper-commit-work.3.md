## Description

**Size:** M
**Files:** cli/find-task-commit.ts, cli/session-state.ts, cli/show-session-files.ts, src/commit-work/trailers.ts (new, or extend src/derivers.ts), test/find-task-commit.test.ts (new), test/session-state.test.ts (new)

### Approach

Fill the three read-only verbs (no flock, no writes). **find-task-commit**
(planctl contract — envelope MUST stay byte-identical): `git log
--grep="Task: <id>" -F --pretty=format:%H` prefilter (the `-F` drops
regex anchors — do the anchoring in the post-filter, do NOT re-add `^Task:$`
under `-F`), then per-candidate confirm via `git log -1 --format=%B <sha>` →
`git interpret-trailers --parse` → partition on `": "`, multi-valued keys →
list, filter through keeper's `parseTaskTrailers` (src/derivers.ts:1384;
`TASK_TRAILER_RE` is module-local — export it or shell interpret-trailers);
resolve repos via the epic's `.planctl/epics/<epic_id>.json` `touched_repos`
walk-up with the three branches (None=cwd-only, []=scan-nothing-success,
all-broken=exit-1) and the `--repos` override (expand `~`, resolve relative).
Never returns `success:false` on a clean miss (empty commits list).
**session-state**: reuse task 1's attribution reader for `session_files`
(wrapped so a DB hiccup degrades to `[]`, never throws) + 4 git reads
(`status --porcelain=v2 --branch`, `log -N --oneline` default N=5, `rev-parse
HEAD` → null in empty repo, `symbolic-ref --short HEAD` → null on detached
HEAD). **show-session-files**: thin pass-through over the attribution reader.
All three emit pretty `indent=2` JSON (NOT the compact commit-work shape).

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/jobctl/jobctl/run_find_task_commit.py — two-stage match, touched_repos resolution, --repos branches, exit codes
- ~/code/arthack/apps/jobctl/jobctl/run_session_state.py — the 4 git reads + null semantics + the bare-except session_files swallow
- ~/code/arthack/apps/jobctl/jobctl/run_show_session_files.py — pass-through shape
- ~/code/keeper/src/derivers.ts:1332-1548 — parseTaskTrailers, parseSessionIdTrailer, extractCommit, TASK_TRAILER_RE

**Optional** (reference as needed):
- ~/code/arthack/apps/cli_common/cli_common/git_trailers.py — _load_trailers (the two-git-call parse to reimplement)

### Risks

- find-task-commit envelope is a planctl fail-loud contract: any shape drift or wrong exit code breaks `run_close_preflight` (COMMIT_LOOKUP_FAILED).
- `-F` literal-match: re-adding regex anchors matches nothing.
- session-state null parity: empty repo head_sha=null, detached branch=null (not "" / not a throw).

### Test notes

find-task-commit: temp repo with a commit carrying `Task: fn-1-x.1`,
assert the `{commits:[...]}` shape + a clean-miss empty list + exit codes for
the --repos branches. session-state: empty repo + detached HEAD null cases.

## Acceptance

- [ ] `keeper find-task-commit` envelope byte-identical to jobctl's; clean miss → empty commits, exit 0; --repos branches map to correct exit codes.
- [ ] session-state returns null (not "" / not throw) for empty-repo head and detached-HEAD branch; DB hiccup degrades session_files to [].
- [ ] show-session-files matches the Python pass-through; all three emit pretty indent=2.
- [ ] trailer parse reuses keeper's parser (no re-port of cli_common.git_trailers logic beyond the interpret-trailers shell-out).

## Done summary
Ported the three read-only jobctl verbs (find-task-commit, session-state, show-session-files) natively into keeper, byte-identical to the retired Python envelopes (verified via diff against jobctl). find-task-commit preserves the planctl fail-loud contract with the two-stage Task: trailer match (reusing keeper's parseTaskTrailers), touched_repos walk-up + --repos override and its three branches/exit codes; session-state ports the four git reads with null parity and the session_files DB-hiccup swallow; show-session-files is the snake_case attribution pass-through. Added test/find-task-commit.test.ts and test/session-state.test.ts (17 cases, all green).
## Evidence
