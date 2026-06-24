## Overview

fn-940 made the wake correct but left it on a SECOND launch transport — the
spec-less `restoreReplayLaunch` shell-wrapper — separate from the agentwrap-tmux
transport every worker/dispatch launch already uses. This epic migrates BOTH
remaining consumers (bus wake + crash-restore) onto agentwrap-tmux by adding a
resume mode to `buildAgentwrapLaunchArgv`, then DELETES the orphaned transport
(`restoreReplayLaunch` + `buildResumeLaunchForm`) and the dead `@keeper_managed`
window marker. End state: ONE launch transport, agentwrap-owned windows with the
same hold-open + managed-reaping, and a meaningful net deletion of code.

## Quick commands

- `keeper agent claude --agentwrap-tmux --agentwrap-tmux-session agentbus --agentwrap-no-confirm --resume "<a-real-session>"`
  — the resume-mode launch the wake/restore now build; resumes and holds the
  pane open in an agentwrap-owned window.
- `keeper bus wake planner@<epic>` — end-to-end wake on the unified transport.
- `bun run test:full && bun run test:hygiene && bunx tsc --noEmit` — full tier +
  no dead exports after the deletion.

## Acceptance

- [ ] Both bus wake + crash-restore launch via `agentwrapLaunch` (resume mode);
  `restoreReplayLaunch` + `buildResumeLaunchForm` deleted.
- [ ] The agentwrap-owned window holds open after claude exits (byte-identical
  hold-open body) and is managed-reaped via the `backend_exec_session_id` binding.
- [ ] `--snapshot-current` dry-run emits the bare agentwrap argv (no double
  `tmux new-window`).
- [ ] The dead `@keeper_managed` window marker is removed; the live
  `@keeper_managed_session` is untouched.
- [ ] Net deletion: one launch transport remains; `tsc --noUnusedLocals` clean.

## Early proof point

Task that proves the approach: `.1` — the wake (the originally-broken,
higher-value path) on the agentwrap transport, with the resume-mode byte-pin
green and the pane holding open. If it fails (e.g. the launcher rejects a
no-prompt `--resume` argv under tmux mode): fall back to keeping a prompt
positional present-but-empty, or leave the wake on the shell-wrapper and
reassess — but the scout verified the no-prompt passthrough, so this is low-risk.

## References

- Seam to mirror: `agentwrapLaunch` (`src/exec-backend.ts:1151`) as called by
  `src/autopilot-worker.ts:1949` + `cli/dispatch.ts:444`.
- Hold-open is byte-identical: agentwrap's `tmuxShellBody()`
  (`src/agent/tmux-launch.ts:856`) equals the hand-rolled `"$@"; exec "$0" -l -i`.
- Overlap: `fn-941` (daemon-driven plan-task block escalation) — `fn-941.3`
  edits `src/exec-backend.ts` + reads `src/bus-wake.ts`/`cli/bus.ts`; wired as a
  dep to serialize the shared edits.
- This is the END state of the resume-launch work (fn-940 → this); nothing
  further is deferred after it.

## Docs gaps

- **CLAUDE.md** (wake bullet ~36-49): wake resumes via the agentwrap transport;
  drop the `buildResumeLaunchForm` / "two LAUNCH producers" framing.
- **README.md** (crash-restore ~3079-3095 + Agent Bus wake ~3256-3265): drop
  `restoreReplayLaunch` + the two-producers substrate.
- **src/exec-backend.ts** module JSDoc (1-18): agentwrap is the SOLE launch
  transport (pane-ops the only remaining direct tmux surface); delete the
  `restoreReplayLaunch` "deferred follow-up" note.
- **src/resume-descriptor.ts** JSDoc: collapse to ONE DISPLAY form.

## Best practices

- **Delete the old path atomically with the last caller's migration** — a
  half-migrated `--resume` transport risks double-attach (`claude --resume` is
  not single-writer). [practice-scout]
- **Verify the launcher actually holds the pane open** before deleting the
  hand-rolled hold-open — byte-identical here, but smoke-test the window survives
  claude exiting. [practice-scout]
- **Find dead exports with `ts-prune` / `tsc --noUnusedLocals`, not just grep** —
  catches the constant/test references a bare symbol search misses. [practice-scout]
