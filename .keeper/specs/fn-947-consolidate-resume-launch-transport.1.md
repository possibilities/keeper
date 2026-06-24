## Description

**Size:** M
**Files:** src/exec-backend.ts, src/bus-wake.ts, cli/bus.ts,
test/exec-backend.test.ts, test/bus-wake.test.ts, CLAUDE.md

### Approach

Add an optional `resumeTarget` to `AgentwrapLaunchOpts`/`LaunchSpec`. In
`buildAgentwrapLaunchArgv` (`src/exec-backend.ts:962`), when `resumeTarget` is
set, emit `--resume <target>` and NO trailing prompt positional — today
`opts.prompt` is the UNCONDITIONAL final positional, so make it conditional.
The worker/dispatch prompt-mode argv stays byte-identical.

Migrate the wake: `runWake` / `defaultWakeLaunch` (`src/bus-wake.ts`) launch via
`agentwrapLaunch` (session = `AGENTBUS_EXEC_SESSION`) instead of
`restoreReplayLaunch`, passing a prompt-less spec carrying `resumeTarget(job)`.
Change the `WakeDeps.launch` seam to carry the resume target (NOT a pre-wrapped
argv) and DELETE `buildWakeResumeArgv`. Drop the wake's `stampManagedWindowMarker`
+ `MANAGED_WINDOW_OPTION`/`MANAGED_WINDOW_VALUE` (dead — no reader; do NOT touch
the live `@keeper_managed_session`). The wake's liveness-recheck / single-flight /
cooldown guards UPSTREAM of the launch are unchanged — only the launch step
swaps, and `agentwrapLaunch` returns the same `LaunchResult` (`{ok}` /
`{ok:false,error,retryable?}`) the `launch_failed`/cooldown path consumes.
Resolve the launcher prefix at the `cli/bus.ts` wake wiring (already available
via `resolveKeeperAgentPathDepFree`). Do NOT delete `restoreReplayLaunch` yet —
crash-restore still consumes it (deleted in `.2`).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:962-988 `buildAgentwrapLaunchArgv` + :918-938
  `AgentwrapLaunchOpts` — make the prompt positional conditional; add `resumeTarget`.
- src/exec-backend.ts:1116-1201 `AgentwrapLaunchDeps`/`agentwrapLaunch` + `LaunchSpec`
  (:77) + `LaunchResult` (:66) — the launch seam + verdict shape.
- src/autopilot-worker.ts:1949 + cli/dispatch.ts:444 — the `agentwrapLaunch` call
  shape to mirror.
- src/bus-wake.ts:294 `runWake`, :373 `defaultWakeLaunch`, :206 `buildWakeResumeArgv`
  (delete), :63 + :383 marker block (delete).
- cli/bus.ts wake wiring (~:613) — launcher-prefix resolution.
- src/agent/tmux-launch.ts:856 `tmuxShellBody` (hold-open byte-identical) +
  :809-832 `buildLaunchScript` (no-prompt passthrough) + :525 session get-or-create.

**Optional** (reference as needed):
- test/exec-backend.test.ts:907,938 — `buildAgentwrapLaunchArgv` byte-pins to extend.

### Risks

- Worker/dispatch prompt-mode byte-pins MUST stay green — the `resumeTarget`
  branch is additive; the prompt path is unchanged. Guard with the existing
  :907/:938 pins plus a new resume-mode pin.
- Empty `resumeTarget` → `--resume ""`; assert a non-empty target in the resume branch.
- `fn-941.3` (in-progress) also edits exec-backend.ts / bus-wake.ts / cli/bus.ts —
  this epic deps on fn-941; rebase on its landed `agentwrapLaunch`/`runWake` shape.
- `--agentwrap-tmux-detached` is hardcoded by `buildAgentwrapLaunchArgv` — correct
  for the background agentbus wake; the old non-detached new-window "current window"
  assumption only mattered for the now-deleted marker stamp.

### Test notes

- Extend test/exec-backend.test.ts `buildAgentwrapLaunchArgv` byte-pins with a
  `resumeTarget` case (emits `--resume <target>`, NO trailing prompt); the
  prompt-mode pins stay byte-identical.
- Rewrite test/bus-wake.test.ts: remove the `buildWakeResumeArgv` tests; the
  `runWake` launch test asserts the `agentwrapLaunch` path (resume spec,
  session=agentbus) + NO marker stamp; the liveness / cooldown / single-flight
  tests stay green (transport-agnostic).
- `bun run test:full` + `bun run test:hygiene`.
- Manual smoke: `keeper agent claude --agentwrap-tmux --agentwrap-tmux-session
  agentbus --resume "<real-session>"` resumes + holds the pane open.

## Acceptance

- [ ] `buildAgentwrapLaunchArgv` emits `--resume <target>` with NO trailing prompt
  when `resumeTarget` is set; prompt-mode argv byte-unchanged (existing pins green
  + a new resume pin).
- [ ] `keeper bus wake` resumes a planner via `agentwrapLaunch` into `agentbus`
  (agentwrap owns the window); the resumed pane holds open after claude exits.
- [ ] The wake's liveness-recheck / single-flight / cooldown guards are unchanged
  and still drive `launch_failed`/cooldown off the `LaunchResult` verdict.
- [ ] `buildWakeResumeArgv` + the dead `@keeper_managed` marker
  (`MANAGED_WINDOW_OPTION`/`MANAGED_WINDOW_VALUE`/`stampManagedWindowMarker`) are
  deleted; the live `@keeper_managed_session` is untouched.
- [ ] `restoreReplayLaunch` still present (crash-restore consumes it until `.2`);
  the CLAUDE.md wake bullet names the agentwrap transport.
- [ ] `bun run test:full` + `bun run test:hygiene` pass.

## Done summary
Added resumeTarget to buildAgentwrapLaunchArgv/LaunchSpec (emits --resume <target>, no prompt) and migrated keeper bus wake onto the unified agentwrapLaunch resume transport; deleted buildWakeResumeArgv and the dead @keeper_managed window marker.
## Evidence
