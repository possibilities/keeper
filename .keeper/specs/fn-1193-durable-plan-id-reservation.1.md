## Description

**Size:** M
**Files:** plugins/plan/src/vcs.ts, plugins/plan/src/flock.ts, plugins/plan/test/fake-vcs.ts, plugins/plan/test/src-flock.test.ts

### Approach

Build the two primitives the rest of the epic composes, entirely inside the plan
plugin (the module boundary forbids importing repo-root src/). First, the PlanVcs
facade gains two methods implemented in realGitVcs and the test fake:
`inProgressOp(cwd)` returning which in-progress operation the state repo's git dir
holds (merge / cherry-pick / revert / rebase / sequencer, or none) by probing
MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD via `git rev-parse -q
--verify` plus a non-empty `.git/sequencer/todo`, and `commitWorkLockPath(cwd)`
deriving `<git-dir>/keeper-commit-work.lock` via `git rev-parse
--path-format=absolute --git-dir` — byte-matching the daemon's derivation so both
acquirer classes contend on the same file. Second, the plan flock module gains a
synchronous deadline-bounded exclusive acquire: LOCK_NB poll with jittered backoff
(~20ms start, ~500ms cap) against an absolute deadline, returning a tagged outcome
(acquired / timeout / environmental-failure), setting FD_CLOEXEC on the lock fd via
fcntl (the lock is held across git child spawns — an inherited fd outlives the
release), and using FFIType.i32 returns. The acquire must be sync (the commit path
is deliberately synchronous — see the busy-wait sleep in commit.ts); never a
blocking LOCK_EX (uninterruptible in Bun).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/flock.ts — existing FFI flock(2) primitives (LOCK_EX/UN/NB, EWOULDBLOCK, errno) and withEpicIdLock's fail-soft discipline; extend, don't fork
- src/commit-work/flock.ts:246 — the async deadline-poll reference to PORT as sync (deadline 45s, backoff constants, tryAcquire shape); do not import it
- src/worktree-git.ts:337-378 — the canonical lock-path derivation argv and worktree-anchored fallback the facade method must match exactly
- plugins/plan/src/vcs.ts:262-634 — realGitVcs method + doc-comment style (each method documents its exact git argv)
- plugins/plan/test/fake-vcs.ts — the in-memory PlanVcs model; add "arm an in-progress op" and lock-path affordances here in the same change

**Optional** (reference as needed):
- plugins/plan/test/src-commit.test.ts — slow-tier real-git test shape (describe.skipIf(!SLOW_ENABLED))
- plugins/plan/test/harness.ts:736 — SLOW_ENABLED / KEEPER_PLAN_RUN_SLOW gating

### Risks

- fcntl is a new dlopen symbol for the plan flock module — F_SETFD/FD_CLOEXEC constants differ per platform (darwin vs linux); pin both and test on darwin at minimum
- A sync poll burns CPU during contention — bounded by the deadline and the jittered backoff cap; do not busy-spin without sleeping
- The probe must read the STATE repo's git dir (the cwd the commit will run in), never the invoking process cwd — a lane worktree's git dir is a different index

### Test notes

Fast tier: fake-vcs unit tests for probe states and lock-path derivation; sync-poll
acquire tested against a real flock held by the same process on a tmpdir lock file
(flock(2) on a plain file needs no git and no subprocess — keep it in-process; if
same-process re-acquire semantics make contention untestable in-process, gate that
one case into the slow tier rather than spawning in the fast tier). Slow tier
(KEEPER_PLAN_RUN_SLOW): real `git init` repos armed into each in-progress state
(real merge conflict, cherry-pick -n, rebase stop) asserting probe classification.

## Acceptance

- [ ] The PlanVcs facade exposes an in-progress-operation probe covering merge, cherry-pick, revert, rebase, and sequencer states, implemented in both the real and fake VCS, and the fake can arm each state
- [ ] The facade derives the commit-work lock path identically to the daemon's derivation for the same checkout (same file for main checkout and for a linked worktree)
- [ ] The plan flock module offers a synchronous deadline-bounded exclusive acquire returning distinct acquired / timeout / environmental outcomes, with close-on-exec set on the held fd
- [ ] `cd plugins/plan && bun test` passes with zero real git spawned in the fast tier

## Done summary

## Evidence
