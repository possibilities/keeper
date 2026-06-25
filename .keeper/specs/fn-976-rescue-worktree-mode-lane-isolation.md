## Overview

Worktree-mode autopilot provisions a per-lane git worktree and overrides the
worker's launch cwd to it, but the `/plan:work` worker re-resolves its
effective repo (`target_repo`/`primary_repo`/`state_repo`) from the immutable
task spec, landing back in the shared main checkout — so concurrent lanes
collide (a `commit-work` race swept one task's files into another's commit).
This epic makes the worker actually operate inside its lane: the producer
injects the realpath-normalized lane path as a producer-only
`KEEPER_PLAN_WORKTREE` env override that all three repo resolutions honor. It
also adds a durable re-dispatch guard so a `TOOLING_FAILURE` block stops the
re-dispatch loop independent of projection fold-lag (the loop that relaunched
one task three times in a row).

## Quick commands

- `bun test test/autopilot-worker.test.ts test/exec-backend.test.ts plugins/plan/test/src-api-spine.test.ts`
- `bun run test:full`   # mandatory — touches daemon/worker/git paths

## Acceptance

- [ ] In worktree mode a worker's `target_repo`, `primary_repo`, AND `state_repo` all resolve to the lane worktree path, not the main checkout.
- [ ] The lane path is a producer-only runtime signal (`KEEPER_PLAN_WORKTREE` env) — never written to the event log as a fold key; re-fold stays deterministic.
- [ ] A `TOOLING_FAILURE` block durably suppresses autopilot re-dispatch of that task independent of projection fold-lag, without breaking the existing unblock / `retry_dispatch` recovery flow.
- [ ] No real-git test added; pure-seam coverage only; the fast `bun test` tier stays fast; `test:full` passes.
- [ ] Single-repo only — multi-repo worktree epics remain rejected.

## Early proof point

Task that proves the approach: `.2` (plan-verb resolution honoring the
override) — pure-unit testable in isolation: set `KEEPER_PLAN_WORKTREE` and
assert all three repos resolve to the lane. If it fails, the env-override seam
is wrong and we reconsider reading env in a helper vs at the call sites.

## References

- Root cause diagnosed in conversation: a `commit-work` race in the shared main checkout swept one task's files into a sibling task's commit because both workers ran in the same checkout instead of their lanes.
- `agentwrap`'s `--agentwrap-tmux-env` is repeatable (accumulates distinct keys, last-wins per dup) — confirmed at `~/code/agentwrap/src/tmux-launch.ts:330-350`. No agentwrap code change needed.
- Overlap (coordinate landing, NOT a blocking dep): `fn-975-thin-test-suite-to-pure-unit-core` tasks `.2`/`.3` gut/thin `test/autopilot-worker.test.ts` + pure-file infra tests — the same files this epic adds pure-seam tests to. This epic lands first (urgent); its tests are deliberately pure-seam, aligned with fn-975's direction, so fn-975 accounts for the additions rather than this epic waiting on it.
- Cross-agent file overlap: another session is fixing the tmux-reaper pane-id recycle-guard in `src/reaper-worker.ts` + `backend_exec_*` plumbing (`autopilot-worker.ts`/`exec-backend.ts`). Coordinate edits to the shared `LaunchSpec` / `AgentwrapLaunchOpts` struct before landing.

## Docs gaps

- **README.md** (worktree-mode block ~3180-3210): rewrite the "sets the launch cwd" sentence to also describe the `KEEPER_PLAN_WORKTREE` env override and that `target_repo`/`primary_repo`/`state_repo` all resolve to the lane.
- **README.md** (dispatch/cooldown ~3000-3080): add the durable `TOOLING_FAILURE` re-dispatch guard alongside the cooldown description; name it durable and the `retry_dispatch` clearing path.
- **plugins/plan/CLAUDE.md** "Environment variables": add `KEEPER_PLAN_WORKTREE`.
- **plugins/plan/template/agents/worker.md.tmpl** (lines 22-25, 70): verify the TARGET_REPO / PRIMARY_REPO / state-write-routing wording still reads correctly when those equal the lane path.
- **CLAUDE.md** Autopilot bullet (line 119): optional one-line note that the three repos resolve to the lane in worktree mode.

## Best practices

- **Inject git/worktree context only at the child boundary, realpath-normalized:** the lane env must be realpath-normalized so the worker's `pwd==TARGET_REPO` check passes (macOS `/var`→`/private/var`); never mutate the daemon's own `process.env`.
- **Classify `TOOLING_FAILURE` as permanent, not transient:** stop auto-requeue, record terminal state, require human recovery; per-task suppression must not block sibling tasks.
- **Bounded suppression, never perpetual:** the durable guard clears on `retry_dispatch` (mirror the existing `failedKeys` human-cleared contract).
