## Description

**Size:** M
**Files:** src/pair-command.ts, cli/pair.ts, test/pair-command.test.ts

### Approach

Switch the **claude** pair/panel partner from the headless `--print -p` builder
to keeper's canonical interactive launch shape, mirroring `buildAgentwrapLaunchArgv`
(`src/exec-backend.ts:928-954`): drop `--print -p`, pass the assembled prompt as
the trailing positional, and inject `--agentwrap-tmux-env KEEPER_TMUX_SESSION=<session>`
so the partner binds into the `jobs` projection as a tracked job (`plan_verb` NULL,
birth-session = the pair/panels session). Stop applying `stripClaudeEnv` for the
claude path — agentwrap's fresh `--session-id` pin keeps the partner transcript
distinct, so the self-collision guard (`cli/pair.ts:405`) still holds (verify).
KEEP the synchronous `wait-for-stop`/`show-last-message` capture and the Monitor
two-line contract exactly as-is — only the spawn shape changes in this task. codex/pi
stay on the headless builder, unchanged. Do NOT touch the reap logic here (task .3).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:928-954 — `buildAgentwrapLaunchArgv`, the interactive launch template (flag set + `KEEPER_TMUX_SESSION` env carrier).
- src/pair-command.ts:179-259 — `buildPairLaunchArgv`/`nativeClaudeArgs` (headless builder to replace); `nativeCodexArgs` stays unchanged.
- cli/pair.ts:317 (`stripClaudeEnv`), :359-393 (capture round-trip), :405 (self-collision guard).
- src/derivers.ts:96-108 — `planVerbRefFromSpawnName`: a non-`verb::id` name folds to `plan_verb` NULL (the tracked-but-non-plan shape).

**Optional**:
- src/exec-backend.ts:330-352 — `buildTmuxNewWindowArgs` (how `KEEPER_TMUX_SESSION` lands in the pane env).
- fn-910 — prior transcript-collision fix context.

### Risks

- KEYSTONE UNKNOWN: `wait-for-stop`/`show-last-message` were validated against headless `--print`; verify they resolve against an interactive TUI transcript and handle the dropped-`message_stop` bug (#27361) via the existing `--timeout`. Prove this early.
- Dropping `stripClaudeEnv` could re-trip the self-collision guard; agentwrap's `--session-id` pin should keep the partner transcript distinct — verify the guard still passes.
- Read-only posture: the interactive TUI must keep `--disallowed-tools Edit,Write,NotebookEdit` + `--dangerously-skip-permissions` and must not hang on a permission prompt.

### Test notes

Update the `buildPairLaunchArgv` byte-pin in test/pair-command.test.ts to the interactive shape. Real tmux/agentwrap verification belongs in a `*.slow.test.ts` (allowlisted) or a documented manual smoke that a claude partner appears as a tracked job and the capture returns the answer — no real tmux in the default tier (fn-904).

## Acceptance

- [ ] claude pair/panel partner launches as an interactive TUI (no `--print -p`), prompt as positional, `KEEPER_TMUX_SESSION` injected.
- [ ] the partner appears as a tracked job (`plan_verb` NULL, birth-session = pair/panels).
- [ ] `wait-for-stop`/`show-last-message` still capture the single-turn answer to `--output`; Monitor two-line `completed` unchanged.
- [ ] read-only posture and the self-collision guard both still hold.
- [ ] codex path unchanged (headless).

## Done summary

## Evidence
