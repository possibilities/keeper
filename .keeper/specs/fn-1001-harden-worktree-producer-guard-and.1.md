## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

When worktree mode is ON and an epic classifies as `ok` (single git toplevel,
`classifyEpicRepo` src/autopilot-worker.ts:1785-1789), ALSO require a non-empty
`epic.primary_repo` before provisioning a lane. If it's null/empty, mint a LOUD,
operator-required reject (e.g. `worktree-no-primary-repo`) on the launch — the same
pre-provision short-circuit shape the `multi-repo` reject already uses
(~:1943-1955 stamping, :2239-2247 short-circuit AHEAD of provision). This stops the
silent degrade where the central resolver, given a null `primary_repo`, roots state
at the locate dir = the LANE (`plugins/plan/src/project.ts:240-242`), so `done`/`claim`
write to the lane branch and `finalizeEpic` deadlocks (isEpicDone never flips).

Scope the new reason OUTSIDE the `worktree-recover*` auto-clear prefix (it's a
config/data problem an operator must fix on the epic def, not a transient) — i.e. a
sticky operator-required reject like `worktree-multi-repo`, not a recover-side
retry-skip. Reuse the multi-repo reject path verbatim where possible (same stamping +
short-circuit), just keyed on the missing-primary condition.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1785-1789 (classifyEpicRepo `ok`/`multi-repo`), :1943-1955 (the multi-repo reject stamping to mirror), :2239-2247 (the pre-provision short-circuit), the reason-prefix scoping (WORKTREE_RECOVER_REASON_PREFIX / the finalize-side sticky reasons)
- plugins/plan/src/project.ts:227-253 (resolvePlanStateContext — confirm the null-primary degrade-to-locate-root it guards against, and that the downstream fail-loud is AFTER a write is attempted)
- test/autopilot-worker.test.ts (the fake-runner classify/dispatch tests; the multi-repo reject test is the shape to copy)

### Risks

- Mirror the multi-repo reject EXACTLY (pre-provision short-circuit, per-key sticky) — do not provision then reject.
- The new reason MUST be operator-required (outside worktree-recover* auto-clear) — a null primary_repo won't fix itself.
- No-op when worktree mode is OFF and for epics that DO have primary_repo (the common case) — byte-identical.

### Test notes

Pure fake-runner: worktree mode ON + an epic with single-toplevel tasks but `primary_repo` null/empty → a loud `worktree-no-primary-repo` reject, NO lane provisioned; an epic WITH primary_repo → provisions as today. Assert via the dispatch-failure list (mirror the multi-repo reject test).

## Acceptance

- [ ] a worktree-`ok` epic with null/empty primary_repo → loud operator-required reject, no lane provisioned
- [ ] an epic with primary_repo set → provisions unchanged (byte-identical)
- [ ] the new reason is OUTSIDE the worktree-recover* auto-clear prefix (sticky, operator-required)
- [ ] fake-runner test covers both; gate green

## Done summary

## Evidence
