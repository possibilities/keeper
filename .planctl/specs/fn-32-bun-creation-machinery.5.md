## Description

**Size:** M
**Files:** src/verbs/epic_create.ts (new), src/verbs/epic_rm.ts (new), src/cli.ts, test/ additions

### Approach

epic create: flock critical section = scan, mint, checkGlobalNameUnique, exists() backstop, write epic JSON + spec; emit outside; branch defaults "main"; single hard emit_error shape (not accumulate-all). epic rm: id traversal guard; resolve cwd-then-global with --project bypass; collect the full unlink set (epic JSON, both spec glob shapes, task JSONs, runtime state, lock files); live-task guard behind --force; --dry-run emits {dry_run: true} with the preview and NO commit; read primary_repo BEFORE unlinking; recordTouched for EVERY collected path BEFORE unlink so the landed commit seam stages the deletions; dangling-dependent warnings non-blocking.

### Investigation targets

**Required** (read before coding):
- planctl/run_epic_create.py and run_epic_rm.py — the source specs
- tests/test_epic_rm.py — the ~9 eligible pins; tests/test_multi_repo_create_validate.py
- src/invocation.ts dirty-probe + src/commit.ts — confirm the deletion-staging path end-to-end once

### Risks

recordTouched-before-unlink ordering is the whole deletion-commit mechanism — a path unlinked without recording becomes an orphaned uncommitted deletion.

### Test notes

test_epic_rm.py + test_multi_repo_create_validate.py eligible sets green via the compiled binary; deletion commits verified in real git.

## Acceptance

- [ ] Both verbs green in their eligible test sets via dist/planctl-bun
- [ ] rm --dry-run produces zero commits and intact files; deletions auto-commit correctly

## Done summary

## Evidence
