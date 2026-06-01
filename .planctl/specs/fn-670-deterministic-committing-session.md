## Overview

Make `/plan:approve` resolve the worker session that actually committed a
task's work, instead of the freshest claim. Today `render-approve-context`'s
`pick_target_job` picks the most-recently-claimed non-approve job by
`created_at`, so an empty aborted re-claim of a task outranks the session
that did the work and committed — the approve judge then reads the aborted
session's `[Request interrupted by user]` and false-rejects correct work
(this is what happened to fn-668-backend-exec-coordinates-on-jobs.2). The
fix is server-side and deterministic: keeper's git-worker learns to parse
the `Task:` trailer and coalesce the `Job-Id:` trailer (which IS the session
UUID — `job_id === session_id` is a keeper invariant) into
`committer_session_id`, which both revives the dormant v45 per-session
commit discharge AND lets `foldCommit` stamp a per-job
`last_commit_for_task_at` timestamp onto the embedded job element under each
`Task:` id. planctl's `pick_target_job` then prefers the job with the
freshest commit-for-this-task, falling back to freshest-claim only when no
job committed. A second, independent correctness fix narrows
`extract_last_assistant_message` to assistant-role turns so an interruption
marker (a `user` turn) can never be read as the worker's final message.

## Quick commands

- `cd /Users/mike/code/keeper && bun test test/git-worker.test.ts test/reducer.test.ts test/db.test.ts test/schema-version.test.ts`
- `cd /Users/mike/code/arthack && uv run pytest apps/planctl/tests/test_render_approve_context.py -q`
- End-to-end: re-run `planctl render-approve-context <a task worked by two sessions>` and confirm the resolved `job_id` is the committing session, with its real final message.

## Acceptance

- [ ] A task worked by a clean-committing session AND a later empty aborted re-claim resolves (via `render-approve-context`) to the committing session, surfacing its real final assistant message — not the aborted session's interrupt marker.
- [ ] keeper's per-session commit discharge (v45 `foldCommit` arm) fires for a `Job-Id:`-trailer commit (no longer dormant); a historical no-trailer commit still global-discharges; a cursor=0 re-fold over a log with pre-v49 (no `task_id`) and new Commit events reproduces byte-identical `epics` rows.
- [ ] SCHEMA_VERSION is 49 and `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS includes 49 in the same change; `test/schema-version.test.ts` green.
- [ ] `extract_last_assistant_message` returns only assistant-role text; a trailing `[Request interrupted by user]` user turn is skipped in favor of the prior assistant turn.

## Early proof point

Task that proves the approach: `.1`. If git-worker cannot reliably extract `Task:` + coalesce `Job-Id` into a UUID-valid `committer_session_id` (e.g. the `Task:` trailer isn't actually stamped on worker commits, or `Job-Id` isn't the session UUID), the whole chain collapses — recovery is to re-confirm trailer provenance via `git show -s --format='%(trailers)'` on real worker commits and, if needed, resolve session via the jobs projection instead of the trailer.

## References

- keeper CLAUDE.md — "Commit discharge is content-aware (schema v45 / fn-664.2)" invariant; the schema-version cross-language gate invariant; re-fold determinism rules.
- `fn-668-backend-exec-coordinates-on-jobs` (dependency + overlap) — landed SCHEMA_VERSION=48 as this epic's base; its pending T3 rewrites the same `reducer.ts` foldCommit/syncJobIntoEpic/EmbeddedJobElement, `db.ts` schema slot, `keeper/api.py` whitelist, and `events-writer.ts` INSERT block — sequence after it to avoid a double-bump collision on the schema slot.
- `fn-669-harden-hook-against-schema-skew` (reverse-dependency) — its column-adaptive INSERT must be built against the FINAL v49 schema; it waits on this epic + fn-668 T3.
- `job_id === session_id` invariant: `cli_common.session_context.current_job_id` returns the Claude Code session UUID, so the `Job-Id:` trailer value passes `UUID_RE`.

## Docs gaps

- **keeper/CLAUDE.md**: revise the v45 "Commit discharge is content-aware" bullet so `committer_session_id` names all three trailer sources (`Session-Id` preferred, else `Job-Id`) + add a new v49 bullet for the epics task→committing-session link.
- **keeper/README.md**: Architecture commit-discharge paragraph (~855-895) — name the three trailer sources + append a terse v49 paragraph.
- **apps/planctl/planctl/run_render_approve_context.py**: update `pick_target_job` docstring (freshest-only → committing-session preference) and `extract_last_assistant_message` docstring (drop the "user or assistant" branch).
- **apps/planctl/skills/approve/SKILL.md**: Rule 1 wording "no user/assistant text turn" → "no assistant text turn".
- **apps/planctl/docs/reference/planctl-bug-history.md**: add an entry for this fix.
- **apps/jobctl/jobctl/run_commit_work.py**: `_FORBIDDEN_TRAILER_RE` comment — note `Task:` is now also consumed by git-worker for session resolution.

## Best practices

- **Git trailers are multi-valued; take-last is the wrong default for `Task:`.** Request via `%(trailers:key=Task,valueonly,unfold,separator=%x00)` and collect ALL values — a commit closing two tasks must link both. (`Session-Id`/`Job-Id` stay take-last — one canonical session per commit.) [git-scm pretty-formats]
- **Freeze derived facts at producer time, never derive in the fold.** `committer_session_id` and `task_id` are parsed by git-worker and frozen in the Commit event payload; historical events stay null on re-fold (forward-only). Never read the transcript or probe liveness inside `foldCommit`. [keeper CLAUDE.md re-fold invariant]
- **One write path per projection field.** The `last_commit_for_task_at` link is written only by `foldCommit`; `buildEmbeddedJob` must preserve (not clobber) it across job-tick re-syncs via the OLD-element carve-out spread.
- **Treat whitespace-only trailer values as absent**, and gate the link write on BOTH `task_id != null` AND `committer_session_id != null`.
