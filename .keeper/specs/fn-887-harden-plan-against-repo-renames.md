## Overview

Make a repo directory rename a graceful, LOUD, EXPLICIT operation instead of
a silent hazard. Two mechanisms: (1) a `keeper plan mv-repo <old> <new>` verb
that rewrites the stored board paths (`primary_repo` / `target_repo` /
`touched_repos`) for a moved repo in one commit; (2) fail-loud — when a
dispatch resolves a cwd that no longer exists on disk, block-with-reason
instead of silently skipping (today's bug). Deliberately NOT auto-healing:
the operator/agent runs `mv-repo` after a rename, and a stale path surfaces
as a visible block with a one-line remediation. Plans stay READ-ONLY inside
keeperd — `mv-repo` is a plan-plugin write (the sole writer of board JSON);
fail-loud reuses keeperd's existing dispatch-failure/block surfacing with NO
new `src/db.ts` projection column.

## Quick commands

- `cd /tmp && git init r-old && keeper plan ... ` then `mv r-old r-new && keeper plan mv-repo $PWD/r-old $PWD/r-new` → board epics/tasks now read r-new, one `chore(planctl): mv-repo` commit
- `keeper plan mv-repo <old> <new>` re-run is a no-op (idempotent: nothing matches `<old>` anymore)
- dispatch a task whose repo dir was removed → exits non-zero / autopilot marks it `blocked: cwd-missing: <path>` (NOT a silent skip), unrelated epics keep dispatching

## Acceptance

- [ ] `mv-repo` rewrites every `primary_repo` / `target_repo` / `touched_repos` entry matching `<old>` → `<new>` across the board in ONE commit; idempotent re-run
- [ ] `mv-repo` validates `<new>` exists + is a git repo and refuses loudly otherwise; matches `<old>` by stored string (realpath-canonicalized), never lowercased
- [ ] dispatch (CLI `cli/dispatch.ts` + autopilot `src/autopilot-worker.ts`) blocks-with-reason on a missing resolved cwd instead of silently skipping; the existence stat lives in PRODUCER paths only (no FS read in any fold arm)
- [ ] no new `src/db.ts` column; fn-881 migration untouched
- [ ] docs updated (plan README mv-repo entry, dispatch SKILL exit taxonomy, exec-backend, plan SKILL note)

## Early proof point

Task that proves the approach: `.1`. It exercises the one genuinely new
pattern — a single verb rewriting N epics + M tasks under ONE `emitMutating`
commit (every existing setter is single-epic). If `runSetter`/restamp won't
generalize cleanly to N epics, fall back to per-epic restamp with a single
batched commit.

## References

- Read-only charter: keeper `CLAUDE.md` — "Plans are READ-ONLY; the plan worker folds `.keeper/{epics,tasks}` into `epics`; no RPC writes a plan field." So `mv-repo` is a plan-plugin write; fail-loud must keep `stat()` out of fold arms.
- Templates: `plugins/plan/src/verbs/epic_set_repos.ts` (set-primary-repo), `task_set_target_repo.ts` (multi-file write + `touched_repos` auto-derive), `validation_restamp.ts` (runSetter spine + VALIDATION_RESTAMP_VERBS + rollback hook), `integrity.ts:71` (validateRepoPath), `store.ts` (atomicWriteJson/resolveUserPath), `emit.ts` (emitMutating vs emitReadonly), `verbs/block.ts` (block runtime state, gitignored, free-text reason).
- Origin incident: the agentuse→agentusage rename (epic fn-8) — a closer silently never dispatched because `primary_repo` pointed at the renamed-away dir; manual fix was `set-primary-repo` + `set-target-repo`.
- Adjacent (do NOT fold in): keeperd slow-fold perf — `SLOW_FOLD_INVESTIGATION.md`.

## Docs gaps

- **plugins/plan/README.md**: add the `mv-repo` verb entry; cross-reference from set-primary-repo / set-target-repo as the bulk-rename path.
- **plugins/plan/skills/plan/SKILL.md** (~:428): companion note to the touched_repos auto-derive line — after a post-scaffold repo rename use `mv-repo`, not per-task set-target-repo.
- **plugins/keeper/skills/dispatch/SKILL.md**: exit-1 taxonomy — split `empty-cwd` into a distinct `cwd-missing` reason with `mv-repo` remediation.
- **docs/exec-backend.md**: `launch`/`ensureLaunched` — document missing-cwd behavior.
- **README.md**: dispatch section — note fail-loud on a missing cwd + the new blocked reason token.

## Best practices

- **Block-with-reason over silent skip** (DLQ pattern): preserve the task as blocked, surface the reason loudly, keep unrelated epics dispatching. [practice-scout]
- **Canonicalize with realpath, never lowercase** for the old↔new comparison; APFS is case-insensitive — use inode/`samefile` semantics, not string-lowercasing. [practice-scout]
