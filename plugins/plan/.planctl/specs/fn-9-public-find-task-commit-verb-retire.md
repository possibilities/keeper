## Overview

Plan 2 of 2 of the keeper-decouple work. A new read-only `planctl find-task-commit <task_id>` verb wraps the shipped `planctl/commit_lookup.py` and emits the keeper-compatible `{success, commits:[{sha,repo}]}` envelope the worker's harness-drop predecessor-detection already parses. The worker agent templates are repointed from `keeper find-task-commit` to `planctl find-task-commit`, and keeper's now-redundant `find-task-commit` verb is deleted from the sibling `../keeper` repo. End state: planctl's worker runbook depends on planctl for commit lookup, and keeper carries no `find-task-commit` surface.

## Quick commands

- `planctl find-task-commit <a-done-task-id>` — emits `{"success": true, "commits": [{"sha", "repo"}]}` for a task whose source commit carries a `Task:` trailer
- `uv run pytest tests/test_find_task_commit.py -q` — the new verb's suite passes
- `grep -rn "keeper find-task-commit" template/ docs/ skills/ ; echo "exit=$?"` — exit 1 (no live worker-side keeper call remains; reconcile negations reworded to `planctl find-task-commit`)
- (keeper repo) `grep -rn "find-task-commit" cli/ src/ test/ README.md ; echo "exit=$?"` — exit 1 after task 3

## Acceptance

- [ ] `planctl find-task-commit <task_id>` returns the keeper-compatible flat `commits:[{sha,repo}]` envelope; clean miss → empty success exit 0; all-repos-broken → `COMMIT_LOOKUP_FAILED` exit 1
- [ ] verb is read-only (no `.planctl/` write, no commit) and rides the readonly invocation footer
- [ ] worker agent templates call `planctl find-task-commit`; the 6 generated `work-plugins/*/agents/worker.md` regenerated; `check-generated` passes
- [ ] no live `keeper find-task-commit` caller remains anywhere in the planctl repo
- [ ] keeper's `find-task-commit` verb, its test, dead `trailers.ts`, and every dispatcher/USAGE/README reference removed; `parseTaskTrailers` (derivers.ts) untouched; keeper's own lint/test pass

## Early proof point

Task that proves the approach: `.1` — the verb must reproduce keeper's success-envelope shape so the worker's predecessor-detection branch is unaffected. If it fails: keep `keeper find-task-commit` in the worker templates and ship only the planctl verb, deferring the migration + keeper deletion.

## References

- **Depends on `fn-7-decouple-close-preflight-from-keeper`**: this epic consumes `planctl/commit_lookup.py` (`find_commit_groups`, `AllReposBrokenError`), shipped by fn-7's task .1 (done). Declared as `depends_on_epics`.
- `planctl/run_resolve_task.py` — the read-only task-keyed verb template (error helpers, `_set_invocation_sentinel`, `_context_for_root`, `find_projects_with_task` resolution, `epic_id_from_task`, read-only-no-commit test).
- `planctl/run_close_preflight.py:119-147` — the `find_commit_groups` call + `AllReposBrokenError`→`COMMIT_LOOKUP_FAILED(details=broken_repos)` mapping to mirror.
- Cross-repo coordination note: epic `fn-8` (reconcile test coverage) edits `tests/test_reconcile.py`, which this epic does not touch — no real overlap, not wired.

## Docs gaps

- **README.md** (Command Map ~59-66): add a present-tense `find-task-commit` blurb + bare-command-list entry.
- **CLAUDE.md** (~line 53, reconcile bullet): reword the `no keeper find-task-commit` negation to name the surviving `planctl find-task-commit`.
- **docs/reference/commit-at-mutation-boundary.md:464**: reword the same reconcile-recovery negation present-tense (do not blind-swap).

## Best practices

- **Envelope byte-compat:** `sha` not `sha256`, `repo` not `repo_path`, full `%H`, empty-result = success exit 0, all-broken = error — never conflate. [practice-scout]
- **Cross-repo ordering:** add verb → migrate consumer → delete producer, as the task chain enforces; grep zero remaining callers (incl. markdown) before keeper deletion. [practice-scout]
- **TS dead-code:** verify `trailers.ts` helpers have zero importers (whole-program reachability + grep) before deleting; `parseTaskTrailers` is a distinct survivor in `derivers.ts`. [practice-scout]
