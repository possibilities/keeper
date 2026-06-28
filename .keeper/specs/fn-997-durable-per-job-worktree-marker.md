## Overview

Give every job a durable `worktree` marker recording the git lane BRANCH it ran in
(`keeper/epic/<id>[/<task>]`), so the `keeper jobs` TUI — and any consumer — can show
"this job ran in a worktree, here's which" as a stable, path-independent fact. The branch
is captured the way `config_dir` / `backend_exec_*` are: producer-injected as a launch env,
frozen into the event by the events-writer hook at SessionStart, folded set-once onto
`jobs.worktree`. It replaces the brittle alternative of inferring worktree-ness from the cwd
path shape — a path that now embeds a provision-time dirhash and is torn down at finalize,
making it a dead reference. End state: a `[⑂ fn-N[/fn-N.M]]` pill on worktree jobs, NULL
(no pill) everywhere else, surviving re-fold byte-identically.

## Quick commands

- `bun test` — full green suite (exec-backend argv, events-writer lockstep, reducer fold, jobs pill, schema-version, refold-equivalence)
- `keeper jobs` — a job dispatched under autopilot worktree mode shows a `[⑂ fn-N…]` lane pill; a serial job shows none
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id, worktree FROM jobs WHERE worktree IS NOT NULL LIMIT 5"` — the durable marker

## Acceptance

- [ ] `jobs.worktree` folds to the verbatim lane branch for worktree launches, NULL for serial; survives resume (set-once) and re-fold (byte-identical)
- [ ] the branch env is always-emitted (no stale-session leak), SessionStart-gated, and rides all three lockstep gates
- [ ] `keeper jobs` renders the epic+rib pill (`keeper/epic/` stripped); NULL → no pill
- [ ] the "never a fold key" rule is amended in-place to distinguish the path env (never folded) from the branch env (captured durable value)

## Early proof point

Task that proves the approach: `.1` — it is the whole vertical slice; the load-bearing risk
is the reducer fold arm + the unconditional env emit. If the fold or the stale-env emit is
wrong, the reducer-lifecycle resume test and the exec-backend argv test catch it before the
pill is even wired.

## References

- Precedent fields to mirror end-to-end: `config_dir` (SessionStart-gated set-once COALESCE fold) and `backend_exec_*` (producer→exec-backend env injection + hook pure `process.env` read).
- The decision to store the branch (not the path) is locked: the lane path `~/worktrees/<base>-<dirhash>--<slug>` carries a provision-time dirhash and is torn down at finalize; the branch is a stable joinable identity that survives `git worktree remove`/`move`.
- The landed worktree-hardening campaign made `KEEPER_PLAN_WORKTREE` (the path env) unconditional; this epic adds a sibling `KEEPER_PLAN_WORKTREE_BRANCH` for the durable marker.

## Docs gaps

- **plugins/plan/CLAUDE.md:46**: amend in-place — split the "never written to the event log as a fold key" claim so the path env stays never-folded and the new branch env is the captured durable `jobs.worktree` value.
- **plugins/plan/src/runtime_status.ts:13**: one-sentence addendum distinguishing the path override from the captured branch sibling env.
- **README.md**: enumerate the new env→`events.worktree`→`jobs.worktree` alongside `config_dir`; add a v94 schema-changelog paragraph (the `backend_exec_*` block is the template); add the `[⑂ …]` pill to the omit-default pill section.
- **keeper/api.py**: add 94 to `SUPPORTED_SCHEMA_VERSIONS` with a one-line comment (the v90–v93 block is the template).

## Best practices

- **Record the value verbatim in the event, read it back verbatim in the fold:** launch-time context must be frozen into the event, never reconstructed from live git on replay — the re-fold determinism guarantee.
- **Store the branch ref, not the path:** the ref survives `git worktree remove`/`move`; the path dangles immediately on teardown.
- **Nullable ADD COLUMN with no DEFAULT:** atomic in SQLite, existing rows NULL; a `DEFAULT ''` would poison the NULL=absent invariant the fold relies on.
- **Empty vs unset env:** collapse `""`/whitespace/unset to NULL at capture so the pill never renders an empty bracket and COALESCE treats absence uniformly.
