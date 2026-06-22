## Overview

Make keeper the sole, reliable owner of `~/docs` git state: every create / update / delete of a doc via Claude tools is committed immediately (per-write, pathspec-scoped, mechanical message), and the repo is pushed to its remote on a debounced cadence. Today NOTHING reliably auto-commits `~/docs` — the gitpolice sitter is read-only (observes keeper.db, never commits), no git hook / cron / other launchd agent commits it, and the occasional "Commit changed docs" entries are manual. So this fills a real gap rather than replacing a daemon.

Depends on `fn-884-docs-metadata-sidecar-migration`: it extends the same keeper-plugin `PostToolUse` sidecar-writer hook fn-884 builds, and must land after it.

## Quick commands

- `bun test test/doc-commit.test.ts test/sidecar-writer.test.ts test/docs-pusher.test.ts`
- `bun run test:full` — mandatory before landing (hook + git process paths)

## Acceptance

- [ ] a Write/Edit/MultiEdit to `~/docs` commits the doc (+ its sidecar) immediately, pathspec-scoped, mechanical message; a delete commits the removal
- [ ] a Stop with local ahead of upstream pushes `~/docs`; nothing-ahead is a no-op; non-fast-forward logs and skips
- [ ] both hooks exit 0 on every path (commit failure, push failure, mid-rebase, detached HEAD, hung git, non-repo docs dir)
- [ ] no daemon/sitter changes needed (the sitter is read-only — confirmed)

## Early proof point

Task that proves the approach: `.1` (per-write committer). If a dep-free port of the commit machinery into a fail-open hook proves unworkable, fall back to a tiny `keeper docs commit` CLI the hook shells.

## References

- Model: `plugins/plan/src/commit.ts` (`autoCommitFromInvocation`, `dirtyFilesForPathspecs`, `gitCommit -F - -- <files>`, `isStageContention`/`isCommitContention`, retry constants) — port DEP-FREE into keeper `src/` (a hook MUST NOT import the plan plugin).
- Reuse `src/derivers.ts`: `extractMutationPath` (Write/Edit/MultiEdit), `extractBashMutation`/`tokenizeShell` (deletes/moves).
- Host hook: `plugins/keeper/plugin/hooks/sidecar-writer.ts` (fn-884); `plugins/keeper/hooks/hooks.json` (PostToolUse matcher is Write+Bash today → widen to Edit/MultiEdit; Stop block has NO matcher key → append a second command for the pusher).
- Test fixtures: `test/helpers/git-repo.ts` `initRepo`, `test/commit-work.test.ts` `addBareOrigin`.
- `~/docs` is on `main` tracking `origin/main` (`git@github.com:possibilities/docs`).

## Rollout

Both hooks are fail-open (exit 0). Push is best-effort (ahead-check + lockfile + non-ff log-and-skip). Rollback: revert the keeper commits + remove the new hooks.json entries; `~/docs` is unaffected (its own repo). The gitpolice census may observe the hook's git subprocess only if it surfaced as an agent tool call — it does not (a hook child process is not a Claude tool call), so no sitter interaction.
