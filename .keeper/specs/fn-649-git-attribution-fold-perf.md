## Overview

The `GitSnapshot` fold (`projectGitStatus` → `findExplicitAttributions` /
`findInferredAttributions`) holds the `BEGIN IMMEDIATE` write lock for up to
41 seconds, starving concurrent hook INSERTs → dead-letter bursts (measured:
`insert:SQLITE_BUSY`, `wait_ms≈2438`). Root cause: the explicit-attribution
Q1 does `json_extract(data,'$.tool_input.file_path')=?` over all 51,641
`PostToolUse` rows (planner lands on `idx_events_hook_event`), per dirty file,
×2 for path+orig_path. Measured 3.56s/file → ×N dirty files = the 16–41s folds.

End state: GitSnapshot folds in single-digit ms; the `insert:SQLITE_BUSY`
dead-letter bursts disappear. Pure performance — no fold-result change, so
re-fold determinism is untouched.

## Quick commands

- `sqlite3 keeper.db "EXPLAIN QUERY PLAN SELECT id FROM events WHERE hook_event='PostToolUse' AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit') AND json_extract(data,'\$.tool_input.file_path')='/x';"` → must show SEARCH USING idx_events_tool_file_path
- Watch `[fold-slow]` in server.stderr drop to ~0 after deploy.

## Acceptance

- [ ] Expression index makes Q1 a seek (verified scratch test: 3556ms → 0ms).
- [ ] GitSnapshot folds drop below the 200ms `[fold-slow]` threshold.
- [ ] `applyPragmas` sets `busy_timeout` before `journal_mode=WAL` (fixes the
  `open:SQLITE_BUSY` drops); hook keeps its tight budget.
- [ ] No fold-result change (re-fold determinism intact); indexes are
  idempotent forward migrations.

## References

- Verified on a VACUUM INTO scratch copy: expression index → sub-ms seek.
- Sequenced ahead of fn-648 (which adds attribution matching).
