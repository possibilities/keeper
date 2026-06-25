## Overview

In autopilot **worktree mode**, the lane geometry places repos by comparing RAW
`target_repo`/`project_dir` strings instead of resolved git toplevels — the one
non-fold read site that skips the `resolveGitToplevel` normalization every other
git-surface read site performs (the README §169-171 invariant). Two failure
modes result: (1) a single-repo epic whose tasks' raw strings differ but resolve
to ONE toplevel (subdir / symlink / trailing-slash) is FALSELY rejected
`worktree-multi-repo`, so no lane provisions and nothing dispatches; (2) an epic
whose tasks share a `target_repo` != `project_dir` forks its lane off the wrong
repo. The fix resolves toplevels ONCE in the producer snapshot-build (mirroring
how `unseededRoots` is resolved and threaded into the pure `reconcile` layer),
threads a pure `worktreeRepoByEpicId` classification map in, consolidates the two
duplicated geometry sites into one pure helper consumed by both gate and
dispatch, and adds a distinct sticky `worktree-repo-unresolved` reject. The pure
layer never shells git — keeper's determinism invariant is preserved.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/readiness.test.ts test/git-toplevel.test.ts`
- `bun run test:full`   # mandatory — touches daemon/worker/git paths

## Acceptance

- [ ] Single-repo epics whose raw `target_repo`/`project_dir` differ but resolve to one toplevel are no longer falsely rejected `worktree-multi-repo`; their lane provisions on the resolved toplevel.
- [ ] An epic whose tasks share a `target_repo` != `project_dir` derives its lane base from the RESOLVED target toplevel, not raw `project_dir`.
- [ ] A genuinely multi-toplevel epic is still rejected; an unresolvable root mints a distinct sticky `worktree-repo-unresolved`.
- [ ] Gate (`buildLaneKeys`) and dispatch (`attachWorktreeGeometry`) consume one shared resolved classification — neither re-derives from raw strings.
- [ ] `reconcile`/worktree-plan stay pure; worktree mode OFF adds zero git spawns; fast tier stays real-git-free; `test:full` passes.

## Early proof point

Task that proves the approach: `.1` — the injected-resolver fast-tier case where
two distinct raw `target_repo` strings resolve to ONE toplevel and the epic is NO
LONGER `worktree-multi-repo`. If it fails, the producer-resolve-then-thread seam
is wrong and we reconsider where classification lives.

## References

- Mirrors the fn-921 toplevel-normalization pattern (`resolveGitToplevel`/`memoizedGitToplevel`, landed); fixes the fn-959 worktree geometry (landed) — the one read site that skipped normalization.
- Reverse-dep / overlap with `fn-976-rescue-worktree-mode-lane-isolation` (open, `.2` in-flight): fn-976 is the WORKER/consumer side (honors the producer's lane path via `KEEPER_PLAN_WORKTREE`); this epic is the PRODUCER geometry side. Hard-wired to land AFTER fn-976 (shared `src/autopilot-worker.ts` + suppression stack; avoids the in-flight merge conflict, builds on fn-976's settled lane base). fn-976.2's `KEEPER_PLAN_WORKTREE` path assertions may need updating to the resolved (not raw) path.
- Coordinate with `fn-975` (thin-test-suite) which reshapes the same test files; this epic's tests are pure-seam, aligned with that direction.
- README §169-171 (normalize at every non-fold read site) and §3196-3198 (multi-repo "rejected loud for v1").

## Docs gaps

- **README.md §3196-3198**: revise — `target_repo`/`project_dir` normalized to toplevels in the producer snapshot-build before the multi-repo guard; name BOTH reject kinds (`worktree-multi-repo` = distinct toplevels; `worktree-repo-unresolved` = could not resolve); reconsider the "for v1" framing for the false-rejection case.
- **README.md §169-171**: confirm the worktree snapshot-build counts as a covered non-fold read site, or add a parenthetical naming the lane geometry.
- **src/autopilot-worker.ts WorktreeReject JSDoc (~688-698) + buildLaneKeys call-site comment (~1276-1285)**: name `worktree-repo-unresolved`; note epics carry pre-resolved repos.

## Best practices

- **Mirror `git rev-parse --show-toplevel`** (the existing resolver) — do NOT introduce `--git-common-dir`; the whole codebase keys on `--show-toplevel`.
- **Fresh per-cycle memo, cache null within a build but GC at cycle end** so a transient failure re-resolves next cycle rather than permanently darkening an epic.
- **No raw-string fast-path** before resolution (`/tmp`→`/private/tmp`, subdir vs root); **short-circuit empty input** before spawning `git -C ""` (resolves to the daemon's own cwd); **strip `GIT_DIR`/`GIT_WORK_TREE`** from the resolve subprocess env (can poison `--show-toplevel`).
