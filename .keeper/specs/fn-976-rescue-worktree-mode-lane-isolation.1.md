## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/exec-backend.ts, test/exec-backend.test.ts, test/autopilot-worker.test.ts

### Approach

When worktree mode provisions a lane in the producer, inject the
realpath-normalized lane path as a `KEEPER_PLAN_WORKTREE` environment entry
into the worker pane, so the worker's `keeper plan` subprocesses can read it
(task `.2` consumes it). The worker-pane env channel is `agentwrap`'s
`--agentwrap-tmux-env` flag — today a single hardcoded `KEEPER_TMUX_SESSION`
entry (`src/exec-backend.ts:794-827`). Thread a new optional worktree-lane
field through `LaunchSpec` -> `AgentwrapLaunchOpts` -> `buildAgentwrapLaunchArgv`
so a second `--agentwrap-tmux-env KEEPER_PLAN_WORKTREE=<lane>` is emitted
ONLY for worktree-mode launches. The lane path equals the existing
`launchCwd` override (`runWorktreeProducerStep`, ~`:1962`); realpath-normalize
it so it matches the worker's eventual `pwd`. `agentwrap` already accepts the
repeated flag (verified) — no agentwrap code change, but the byte-pinned argv
fixture in `test/exec-backend.test.ts` and the drift guard vs
`~/code/agentwrap/src/` must move in lockstep. Keep non-worktree and `pair`
(`src/pair-command.ts:222`) launch argv byte-identical. Ensure the
resume/crash-restore launch path re-injects the env (a resumed worker must
not re-resolve to main).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:738-764 — LaunchSpec / AgentwrapLaunchOpts (add the optional field)
- src/exec-backend.ts:794-827 — buildAgentwrapLaunchArgv (emit the 2nd flag)
- src/autopilot-worker.ts:1942-2129 — runWorktreeProducerStep / buildPlannedLaunchSpec (inject the realpath-normalized lane)
- src/worktree-plan.ts — worktreePathFor (the lane path source)
- test/exec-backend.test.ts — the byte-pinned argv fixture to update

**Optional** (reference as needed):
- src/pair-command.ts:222 — parallel --agentwrap-tmux-env builder (keep byte-identical)
- ~/code/agentwrap/src/tmux-launch.ts:330-350 — confirms repeatable-flag semantics

### Risks

- Cross-repo agentwrap contract: the flag is repeatable but the fixture + drift guard must move in lockstep or test:full breaks.
- The lane env must NOT enter the event log as a fold key (producer-only; `PlannedLaunch.worktree` is already "never a fold input").
- A missing/empty lane must leave non-worktree launches byte-identical.
- The resume path must re-inject or a resumed worktree worker collides on main.
- Cross-agent: another session edits the same LaunchSpec/AgentwrapLaunchOpts struct (reaper backend_exec_* work) — coordinate before landing.

### Test notes

Pure seam only — NO real git, no real-git allowlist entry. In
test/autopilot-worker.test.ts inject the fake WorktreeDriver and assert the
captured LaunchSpec carries the realpath-normalized lane env for a
worktree-mode launch and NOT for a non-worktree launch. Update the
test/exec-backend.test.ts argv fixture for the new flag.

## Acceptance

- [ ] A worktree-mode launch emits `--agentwrap-tmux-env KEEPER_PLAN_WORKTREE=<realpath lane>`; a non-worktree / pair launch is byte-identical to today.
- [ ] The injected lane path is realpath-normalized (equals the worker's launch cwd).
- [ ] The resume / crash-restore launch path re-injects `KEEPER_PLAN_WORKTREE`.
- [ ] `KEEPER_PLAN_WORKTREE` never appears in any synthetic event / projection column.
- [ ] test/exec-backend.test.ts fixture + drift guard updated; pure-seam tests pass; no real-git test added.

## Done summary
Producer now injects a realpath-normalized KEEPER_PLAN_WORKTREE lane env (a 2nd --agentwrap-tmux-env entry) for worktree-mode launches, threaded through LaunchSpec -> AgentwrapLaunchOpts -> buildAgentwrapLaunchArgv; non-worktree/pair launches stay byte-identical and the flag rides resume mode too. Pure-seam tests only.
## Evidence
