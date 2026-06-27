## Description

**Size:** S
**Files:** src/exec-backend.ts (buildAgentwrapLaunchArgv), src/exec-backend.test.ts or the agentwrap-argv byte-pin test

### Approach

The worker launch emits `--x-tmux-env KEEPER_PLAN_WORKTREE=<lane>` ONLY in worktree mode; serial launches OMIT it. tmux persists `-e` vars into the SESSION environment, so a serial (or different-lane) launch in a tmux session previously used by a worktree launch INHERITS the stale lane path — poisoning target_repo resolution for the next worker (observed: a serial worker got a deleted lane as TARGET_REPO and self-blocked). Fix: make every worker launch set KEEPER_PLAN_WORKTREE EXPLICITLY — the lane in worktree mode, EMPTY ("") in serial mode — so the `-e` always OVERWRITES any stale session-env value. `worktreeOverride()` already treats empty as "unset" (`return v ? v : undefined`), so an explicit empty is semantically identical to today's omission for resolution, minus the leak. Keep the change to the launch argv builder; do not alter resolution semantics.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:818-857 buildAgentwrapLaunchArgv — the `opts.worktreePath !== undefined && !== ""` conditional emit at :851-853 (the leak source: serial omits the flag).
- src/agent/tmux-launch.ts:331-356 addTmuxEnv (accumulate-by-key) + envArgs:659 (`-e KEY=VALUE`) — confirms an empty value round-trips as `-e KEEPER_PLAN_WORKTREE=` and tmux clears/overwrites the session var.
- plugins/plan/src/runtime_status.ts worktreeOverride — confirm empty -> undefined (serial resolution unchanged).
- Any byte-pin / argv test for buildAgentwrapLaunchArgv (the serial argv shape changes — it gains the empty entry).

### Risks

- Byte-pin tests: the SERIAL launch argv now includes `--x-tmux-env KEEPER_PLAN_WORKTREE=` (empty). Update every byte-pin assertion; confirm the agentwrap parser accepts an empty value (addTmuxEnv stores it; envArgs emits `-e KEEPER_PLAN_WORKTREE=`).
- Resolution must stay unchanged in serial mode: empty override -> falls through the fallback chain to task.target_repo (verify worktreeOverride treats "" as undefined).

### Test notes

Fast-tier: assert buildAgentwrapLaunchArgv ALWAYS includes exactly one KEEPER_PLAN_WORKTREE entry — the lane when worktreePath is set, empty when it is not — so a stale session-env value can never be inherited. No real tmux needed: the argv-shape assertion is the structural proof that the `-e` overwrite always happens.

## Acceptance

- [ ] buildAgentwrapLaunchArgv always emits a single `--x-tmux-env KEEPER_PLAN_WORKTREE=<lane-or-empty>` entry (lane in worktree mode, empty in serial), overwriting any stale tmux session-env value.
- [ ] Serial resolution is unchanged: an empty override falls through to task.target_repo (worktreeOverride treats "" as undefined).
- [ ] Byte-pin / argv tests updated to the new serial shape; typecheck + lint green; the default fast `bun test` stays pure.

## Done summary

## Evidence
