## Description

**Size:** M
**Files:** scripts/restore-agents.ts, src/exec-backend.ts, src/resume-descriptor.ts,
test/restore-agents.test.ts, test/exec-backend.test.ts, test/resume-descriptor.test.ts,
README.md

### Approach

Migrate crash-restore onto the agentwrap resume transport, then DELETE the
now-orphaned shell-wrapper transport.

(1) Live restore: `applyRestore` / `ensureLaunched` (`scripts/restore-agents.ts`)
launch each candidate via `agentwrapLaunch` into the candidate's recorded
`backend_exec_session_id`, passing a prompt-less spec with `resumeTarget =
candidate.resume_target`. Delete `buildResumeLaunchArgv`; reshape `EnsureLaunchedFn`
to carry the resume target (mirroring `.1`'s wake seam). agentwrap get-or-creates
an arbitrary session (`src/agent/tmux-launch.ts:525`), so per-candidate sessions work.

(2) `--snapshot-current` DRY-RUN: `renderSnapshotScript` (`scripts/restore-agents.ts:454`)
currently wraps the inner argv in `tmux has-session`/`new-session`/`new-window` TEXT.
Under agentwrap the spawned `keeper agent … --agentwrap-tmux` creates its OWN
session+window, so that wrapper would DOUBLE-create. Re-render the bare
`buildAgentwrapLaunchArgv` (with `resumeTarget`) via `shellQuote`, byte-aligned with
what `--apply` now spawns — drop the tmux-session/window wrapper text.

(3) DELETE the orphaned transport ATOMICALLY with migrating restore's last caller
(no half-migration): `restoreReplayLaunch` + `RestoreReplayDeps` + `launchIntoTmux`
(`src/exec-backend.ts`), `buildResumeLaunchForm` (`src/resume-descriptor.ts`), and
`buildTmuxSetWindowOptionArgs` IF `ts-prune`/`tsc --noUnusedLocals` confirms it's
dead. KEEP `buildTmuxHasSessionArgs`/`NewSessionArgs`/`NewWindowArgs` (still used
by `renderSnapshotScript`) and `buildResumeCommand` (the DISPLAY form).

(4) Doc sweep across the affected files (see Docs gaps).

### Investigation targets

**Required** (read before coding):
- scripts/restore-agents.ts:280 `applyRestore`, :629 `ensureLaunched`, :213
  `buildResumeLaunchArgv` (delete), :454 `renderSnapshotScript` (re-render bare argv).
- src/exec-backend.ts:766-826 `restoreReplayLaunch`/`RestoreReplayDeps`/`launchIntoTmux`
  (delete); the tmux-arg builders (KEEP); `buildTmuxSetWindowOptionArgs` (delete if dead).
- src/resume-descriptor.ts:108 `buildResumeLaunchForm` (delete) + module JSDoc
  (collapse to DISPLAY-only).
- src/agent/tmux-launch.ts:525 session get-or-create (arbitrary session is safe).

**Optional** (reference as needed):
- test/restore-agents.test.ts:152-217 `renderSnapshotScript` pins + :225
  `buildResumeLaunchArgv`; test/exec-backend.test.ts:305-560 `restoreReplayLaunch`
  suite (delete) + :290 `buildTmuxSetWindowOptionArgs` test; test/resume-descriptor.test.ts:98-149 (delete).

### Risks

- The `renderSnapshotScript` regression is INVISIBLE until the next crash (its tests
  pin TEXT, not execution) — the byte-alignment with `--apply` must be exact; pin the
  new bare-agentwrap-argv text.
- Restore round-trip: agentwrap injects `KEEPER_TMUX_SESSION=<recorded session>` (the
  old direct replay did not for human-named sessions). Verify restored windows bind to
  the SAME live `backend_exec_session_id` as before (re-derived by `TmuxTopologySnapshot`);
  the added `backend_exec_birth_session_id` stamp on restored agents is acceptable/
  more-correct — confirm it doesn't mis-group the dash.
- Half-migration: delete `restoreReplayLaunch` ONLY after restore's last caller is
  switched, in THIS task (the dep on `.1` ensures the wake already migrated).
- Run `ts-prune` / `bunx tsc --noEmit` (with noUnusedLocals) to confirm zero remaining
  importers before each deletion.

### Test notes

- Rewrite test/restore-agents.test.ts `buildResumeLaunchArgv` + `renderSnapshotScript`
  tests to the agentwrap-argv shape; add a text-pin asserting the bare
  `keeper agent … --agentwrap-tmux … --resume <target>` (NO `tmux new-window` wrapper).
- Delete the `restoreReplayLaunch` suite (test/exec-backend.test.ts:305-560), the
  `buildTmuxSetWindowOptionArgs` test (:290, if dropped), and the
  `buildResumeLaunchForm` tests (test/resume-descriptor.test.ts:98-149).
- `bun run test:full` + `bun run test:hygiene`; `tsc` clean (no unused exports).

## Acceptance

- [ ] Crash-restore launches each candidate via `agentwrapLaunch` (per-candidate
  recorded session, prompt-less resume spec); per-candidate failure isolation
  preserved off the `LaunchResult` verdict.
- [ ] `--snapshot-current` emits the bare `keeper agent claude --agentwrap-tmux …
  --resume <target>` argv (shell-quoted), byte-aligned with `--apply`; NO double
  `tmux new-window` wrapper.
- [ ] `restoreReplayLaunch`, `RestoreReplayDeps`, `launchIntoTmux`,
  `buildResumeLaunchForm`, `buildResumeLaunchArgv`, and (if dead)
  `buildTmuxSetWindowOptionArgs` deleted with their tests; `tsc --noUnusedLocals` clean.
- [ ] `buildResumeCommand` (DISPLAY) + `buildTmuxHasSessionArgs`/`NewSessionArgs`/
  `NewWindowArgs` retained; `@keeper_managed_session` untouched.
- [ ] Restored agents bind to the same `backend_exec_session_id` as before
  (round-trip verified).
- [ ] Doc sweep: README crash-restore + Agent Bus, exec-backend module JSDoc
  (agentwrap = sole transport), resume-descriptor JSDoc (DISPLAY-only), restore-agents JSDoc.
- [ ] `bun run test:full` + `bun run test:hygiene` pass.

## Done summary
Migrated crash-restore (--apply + --snapshot-current) onto agentwrapLaunch resume mode, the same transport keeper bus wake uses; deleted the orphaned shell-wrapper transport (restoreReplayLaunch/launchIntoTmux/buildResumeLaunchForm/buildResumeLaunchArgv), the dead @keeper_managed marker, and now-dead buildTmuxNewWindowArgs. One launch transport remains; full suite + hygiene + tsc clean.
## Evidence
