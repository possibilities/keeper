## Description

**Size:** M
**Files:** cli/pair.ts, src/pair-command.ts, test/pair-cli.test.ts, test/pair-command.test.ts

### Approach

Replace pair's subprocess compose (`cli/pair.ts:424-513`) with the in-process path: build pair's posture-laden launch through task 1's shared helper (full posture — `buildPairLaunchArgv` with `readOnly`/`preset`/`model`/`effort`/`session` + `assemblePrompt` + `stripClaudeEnv` + `ensureCodexDirTrust`, ALL UNCHANGED; thread `stopTimeoutMs = stopTimeoutMsFromSeconds(timeoutSeconds)` onto `ResolvedHandle.stopTimeoutMs`) → call `composeRunCapture`/`captureFromHandle` with the real `runWaitForStop`/`runShowLastMessage` seams + `verbDeps = {env, homeDir: homedir()}` → switch on `envelope.outcome` and map to pair's contract. Keep the success tail (`cli/pair.ts:522-564`: gitSnapshot-after → `buildPairOutput` → `pairOutputYaml` → atomic temp-write+rename → `emitEvent("completed")` AFTER rename → exit 0) UNCHANGED; the git read-only backstop still brackets the compose (before-snapshot pre-launch, after-snapshot ONLY on the success arms). DROP the `PATH_CEILING_MS + SLOP_MS` kill margin + the `isSelfTranscriptCollision` guard (redundant in-process — handle held locally; document the structural reason at the deletion site). Map outcome at ONE exhaustive `never`-checked boundary → pair's 0/1/2 taxonomy (do NOT adopt `runCaptureExitCode`).

### Outcome → pair mapping (behavior-stable — implement exactly)

- `completed` → success tail, `completed` line, exit 0.
- `no_message` → success tail, `completed` line, `message: null`, exit 0 (old pair always succeeded on a tool-only final turn; runs the after-snapshot).
- `timed_out` / `no_transcript` / `launch_failed` → `fail()` (`failed` line + exit 1) BEFORE any output file is written; drop any partial message; coarse outcome-derived `error=` text (panel surfaces it as the leg `reason`).
- `bad_args` → defensive `fail()`/exit 1 (unreachable — pair validates args pre-compose; exit 2 stays pre-compose). `never`-checked default → exit 1.

### Investigation targets

**Required** (read before coding):
- cli/pair.ts:424-513 (the compose to replace), :522-564 (the success tail to keep), :351-357 (SIGTERM handler — can now fire mid-`await`), :120-128/:468 (the kill margin to drop), :299-329 (pair's own arg validation — exit 2 stays here).
- src/agent/launch-handle.ts (task 1's helper — pair's launch seam), src/agent/run-capture.ts:244-321 (`captureFromHandle`/`composeRunCapture` + the outcome set), src/agent/pair-subcommands.ts:235-294 (`runWaitForStop`/`runShowLastMessage`).
- src/pair-command.ts — KEEP `buildPairLaunchArgv`/`assemblePrompt`/`buildPairOutput`/`pairOutputYaml`/`stripClaudeEnv`/`loadRolePrompt`/`diffGitSnapshots`/`stopTimeoutMsFromSeconds`; DROP `buildWaitForStopArgv`/`buildShowLastMessageArgv`/`parsePairLaunchJson`/`parseShowLastMessageJson`/`isSelfTranscriptCollision` (+ helpers) once the compose is removed.
- test/pair-cli.test.ts:141-303 (the ~8 launch-failure/`--preset` assertions that break — re-target via an injected tmux seam forcing `TmuxLaunchError`), test/agent-run-capture-golden.test.ts (the byte-stability guard — keep green).

**Optional** (reference as needed):
- src/pair/panel.ts:330-335 (consumes the failed-line `error=` + the two-line contract — byte-sensitive), test/pair-command.test.ts (the dead-builder unit tests to drop).

### Risks

- **Behavior-stability:** the `--output` YAML + the two `[keeper-pair]` lines (started pre-compose, completed/failed post-rename, SAME order) + exit codes byte-identical — the golden test is the guard; keep it green. `pair panel` byte-depends on this.
- **Test isolation:** the in-process launch would shell real tmux — pair's launch must take the injectable tmux seam (from task 1) so launch-failure tests force `TmuxLaunchError` without real tmux.
- **`homeDir` must be `homedir()`** (match `MainDeps.transcriptHomeDir`) or transcript resolution silently fails → spurious `no_transcript`.
- **`launcherArgvPrefix` dual role:** call `buildPairLaunchArgv` with `launcherArgvPrefix:[]` then `.slice(1)` for the parse; the REAL prefix goes to the launch helper's `launcherArgvPrefix`.
- **Dead-code removal** widens the diff into `src/pair-command.ts` + `test/pair-command.test.ts` — confirm grep shows only `cli/pair.ts` + tests reference the dropped builders before deleting.

### Test notes

Migrate `test/pair-cli.test.ts` launch-failure coverage to the injected tmux seam (force `TmuxLaunchError` → `launch_failed` → started+failed+exit 1 at the CLI boundary, preserving the two-line contract). Add in-process compose tests via injected wait/show/now seams (mirror `test/agent-run-capture.test.ts`) covering each `outcome → pair` mapping. Drop the dead-builder unit tests from `test/pair-command.test.ts`. Keep the golden test green. No real subprocess/tmux/git.

## Acceptance

- [ ] pair's subprocess compose (`cli/pair.ts:424-513`) replaced by the shared launch helper + `composeRunCapture`; the kill margin + `isSelfTranscriptCollision` dropped (deletion rationale documented at the site).
- [ ] Every `RunCaptureOutcome` maps to pair's contract per the behavior-stable table (completed & no_message → completed/exit 0; timed_out/no_transcript/launch_failed → failed/exit 1; defensive bad_args + `never`-default → exit 1); mapping is ONE exhaustive `never`-checked switch; exit 2 stays pre-compose.
- [ ] Posture UNCHANGED (read-only directive+tool-strip+git backstop, env strip, codex trust, role/system-prompt); the `--output` YAML + two Monitor lines + exit codes byte-identical (golden test green).
- [ ] Dead builders (`buildWaitForStopArgv`/`buildShowLastMessageArgv`/`parsePairLaunchJson`/`parseShowLastMessageJson`/`isSelfTranscriptCollision`) + their tests removed; stale subprocess-compose module comments in `cli/pair.ts` + `src/pair-command.ts` rewritten forward-facing.
- [ ] Launch-failure tests re-targeted via the injected tmux seam; in-process compose tests cover each outcome; `bun test` green.

## Done summary

## Evidence
