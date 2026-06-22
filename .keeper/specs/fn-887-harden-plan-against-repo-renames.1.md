## Description

**Size:** M
**Files:** plugins/plan/src/verbs/mv_repo.ts (new), plugins/plan/src/cli.ts (register), plugins/plan/src/validation_restamp.ts (VALIDATION_RESTAMP_VERBS), plugins/plan/test/verbs-restamp.test.ts (or a new mv-repo test), plugins/plan/README.md, plugins/plan/skills/plan/SKILL.md

### Approach

Add a metadata-only `mv-repo <oldPath> <newPath>` plan verb that rewrites
the stored board paths for a renamed repo. It does NOT move any directory —
the operator moves the dir; this fixes the board. `resolveUserPath` both args
(realpath-canonicalize); `validateRepoPath(newPath)` (exists + `.git/`) and
refuse loudly if it fails. Match `<old>` by the stored STRING (canonicalized)
— the old dir is gone on disk by definition of a rename, so match by value,
never by stat. Walk the project's epics + tasks: rewrite `primary_repo == old → new`,
each `touched_repos` entry `== old → new` (or re-derive via the existing
union-of-child-target_repos recompute), and each task `target_repo == old → new`.
Per-file `atomicWriteJson`, restamp every touched epic, then ONE `emitMutating`
commit staging all touched files. Add `mv-repo` to `VALIDATION_RESTAMP_VERBS`.
Naturally idempotent (already-rewritten files no longer match `<old>`).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/epic_set_repos.ts — set-primary-repo/set-touched-repos spine (resolveProject → existsSync guard → resolveUserPath → runSetter → emitMutating); warn-and-write posture when newPath lacks .git.
- plugins/plan/src/verbs/task_set_target_repo.ts — multi-file write + `touched_repos` recompute from union of child target_repos (preRestamp); the `:50` no-epic fail-forward branch.
- plugins/plan/src/validation_restamp.ts:28 (VALIDATION_RESTAMP_VERBS — add mv-repo), :256 (runSetter — single-epic spine to GENERALIZE to N epics), :243 (single-epic rollback hook).
- plugins/plan/src/integrity.ts:71 (validateRepoPath — use for NEW only; it fails ENOENT so it can't validate OLD), :84 (samefile dev/ino primitive if needed).
- plugins/plan/src/store.ts (atomicWriteJson, resolveUserPath, withTaskLock), emit.ts (emitMutating single commit — confirm it accepts an N-file pathspec), cli.ts (verb registration: GroupSpec entry + switch case + leafPositionals arg parse).
- plugins/plan/src/discovery.ts / project.ts (walk epics + sibling task files).

### Risks

- `runSetter`/restamp are single-epic today; rewriting N epics under one commit is the new pattern. If it won't generalize cleanly, fall back to per-epic restamp + a single batched commit. Confirm emitMutating's touched-log/session machinery accepts an arbitrary-length pathspec.
- Stored paths are un-normalized (user-entered); the old-match must realpath BOTH sides. macOS APFS is case-insensitive — never lowercase; compare via realpath/samefile semantics.
- Edge cases: `old == new` after canonicalize → no-op (no empty commit churn); `<new>` already an owning `.keeper` board → refuse/warn; an epic with `primary_repo == old` but a DIFFERENT stale `touched_repos` entry → rewrite only exact-old matches (leave others; a second mv-repo handles them); epic with zero child tasks (no touched_repos recompute) and the no-epic-file branch.

### Test notes

Model `plugins/plan/test/verbs-restamp.test.ts` with `runCli` + two git repos (old + new) via the harness. Assert: primary_repo + target_repo + touched_repos all rewritten old→new; exactly one commit (`gitLogCount`/`headSubject`); idempotent re-run is a no-op; `<new>` not-a-git-repo fails loud; `old==new` is a no-op. Plan lint = biome + tsc; `bun test` under plugins/plan.

## Acceptance

- [ ] `keeper plan mv-repo <old> <new>` rewrites every matching primary_repo / target_repo / touched_repos old→new in ONE commit; registered in cli.ts + VALIDATION_RESTAMP_VERBS
- [ ] validates `<new>` (exists + .git) and refuses loudly otherwise; matches `<old>` by realpath-canonicalized stored string; never lowercases
- [ ] idempotent re-run (no-op); `old==new` no-op; restamp keeps every touched epic valid
- [ ] plugins/plan/README.md mv-repo entry + plan SKILL.md companion note added
- [ ] plan-plugin lint (biome + tsc) + `bun test` green

## Done summary

## Evidence
