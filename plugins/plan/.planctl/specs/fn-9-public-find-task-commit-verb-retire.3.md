## Description

**Size:** M
**Files (in ../keeper):** cli/find-task-commit.ts, test/find-task-commit.test.ts, cli/keeper.ts, test/keeper-cli.test.ts, src/commit-work/trailers.ts, README.md, test/helpers/sandbox-env.ts

Delete keeper's now-redundant `find-task-commit` verb and every reference to it. MUST land after task 2 (the worker runbook no longer calls it). This task runs in the `../keeper` repo (target_repo).

### Approach

First confirm zero remaining callers across BOTH repos: `grep -rn "find-task-commit" /Users/mike/code/planctl /Users/mike/code/keeper` should show only keeper's own definition/registration/tests (planctl migrated in task 2). Then:
- Delete `cli/find-task-commit.ts` and `test/find-task-commit.test.ts`.
- De-register in `cli/keeper.ts`: remove the `find-task-commit` member from the `SUBCOMMANDS` tuple (~line 34) AND the `Subcommand` type, the `USAGE` text line (~53), and the `handlers` dispatch entry (~136-137). A stale `Subcommand` type member or handler will fail keeper's typecheck.
- Fix `test/keeper-cli.test.ts`: remove the `handlers` mock entry (~line 56) and the `isSubcommand("find-task-commit")` assert (~176) — these break once the subcommand leaves the type.
- Delete `src/commit-work/trailers.ts` ENTIRELY: verify (whole-program reachability via tsr/ts-prune + `grep -rn "from.*commit-work/trailers\|loadTrailers\|hasRealTaskTrailer" src test cli`) that `loadTrailers`/`hasRealTaskTrailer` are imported ONLY by the deleted `find-task-commit.ts`. Do NOT touch `parseTaskTrailers` in `src/derivers.ts` — it is a distinct symbol used by `git-worker.ts` + `reducer.ts` and MUST survive.
- Remove the `find-task-commit` block in `README.md` (~1053-1060) and the cosmetic `find-task-commit` mention in `test/helpers/sandbox-env.ts:12`.
- Regenerate any keeper help/README artifacts if keeper auto-generates them; run keeper's own lint + typecheck + test matrix (investigate keeper's package.json scripts / CONTRIBUTING) and ensure green. Commit via keeper's own source-commit flow.

### Investigation targets

**Required** (read before coding):
- ../keeper/cli/keeper.ts — `SUBCOMMANDS` tuple, `Subcommand` type, `USAGE`, `handlers` map (the de-registration sites)
- ../keeper/cli/find-task-commit.ts — the verb being deleted (confirm its only imports of trailers.ts)
- ../keeper/src/commit-work/trailers.ts — `loadTrailers`/`hasRealTaskTrailer` (verify zero other importers before deleting the module)
- ../keeper/src/derivers.ts — `parseTaskTrailers` (the survivor; confirm it is NOT in trailers.ts and stays)
- ../keeper/test/keeper-cli.test.ts:56,176 — the test refs that break on type removal
- ../keeper/test/find-task-commit.test.ts — delete
- ../keeper/README.md:1053-1060, ../keeper/test/helpers/sandbox-env.ts:12 — doc/comment refs
- keeper's package.json / CONTRIBUTING — the lint/typecheck/test commands to run

### Risks

- **Hidden survivors:** `parseTaskTrailers` (derivers.ts) is a different symbol from `trailers.ts` helpers — deleting derivers logic would break `git-worker.ts`/`reducer.ts`. Verify reachability before deleting `trailers.ts`.
- **Type/registration drift:** leaving the `Subcommand` type member or a `handlers`/USAGE/test ref fails keeper's typecheck or tests. Remove all sites in one commit.
- **Ordering:** must come last — re-grep both repos for live `keeper find-task-commit` callers (incl. markdown) before deleting.

### Test notes

Run keeper's own lint + typecheck + full test suite (not planctl's). `grep -rn "find-task-commit" /Users/mike/code/keeper` returns nothing after. Confirm `parseTaskTrailers` tests still pass.

## Acceptance

- [ ] `cli/find-task-commit.ts` + `test/find-task-commit.test.ts` deleted
- [ ] `cli/keeper.ts` SUBCOMMANDS tuple + `Subcommand` type + USAGE + handlers entry all drop `find-task-commit`; `test/keeper-cli.test.ts` refs removed
- [ ] `src/commit-work/trailers.ts` deleted (verified zero other importers); `parseTaskTrailers` in `derivers.ts` untouched
- [ ] `README.md` + `sandbox-env.ts` refs removed
- [ ] keeper's own lint/typecheck/test matrix green; `grep -rn "find-task-commit" ../keeper` returns nothing

## Done summary
Deleted keeper's redundant find-task-commit verb, its test, and the dead src/commit-work/trailers.ts module; de-registered from keeper.ts SUBCOMMANDS/USAGE/dispatch and dropped all test/README/sandbox-env refs. parseTaskTrailers (derivers.ts) survives. Keeper lint/typecheck/test matrix green; zero find-task-commit refs remain in keeper.
## Evidence
