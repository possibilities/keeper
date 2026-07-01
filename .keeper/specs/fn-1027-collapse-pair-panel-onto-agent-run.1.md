## Description

**Size:** M
**Files:** src/agent/run-capture.ts, src/agent/main.ts, src/agent/dispatch.ts, cli/agent.ts, README.md, test/agent-run-capture.test.ts, test/agent-byte-pin.test.ts

### Approach

Add three flags to `agent run`, all ADDITIVE + default-absent (absent → byte-identical argv/env; `pair send` + managed launches untouched):
- **`--preset <name>`** + **`--session <name>`**: VALUE flags in `parseRunArgs` (`run-capture.ts:141`, mirror the `--stop-timeout-ms` split + `=` arms + add to `ParseRunArgsResult`); thread into the handler posture-build (`main.ts:808`, currently `{readOnly}` at `:839`) → `LaunchPosture.preset`/`.session` (ALREADY carried into `buildPairLaunchArgv`; the launch substrate needs no change). **`--preset` validates its resolved harness == the positional `<cli>`** (via the same resolver `resolvePanelMembers`/`resolvePreset` use, `config.ts:521`) → `bad_args` on mismatch (closes the standalone foot-gun; agent run is otherwise config-free and can't derive `<cli>` from the preset).
- **`--output <path>`**: write the 9-key JSON envelope ATOMICALLY (temp-in-same-dir + rename, EXDEV-safe — mirror `writeFileAtomic`, `panel.ts:288`) inside the emit path (`emitRunCapture`, `main.ts:778`) so it is written on EVERY outcome (completed/no_message/timed_out/no_transcript/launch_failed/bad_args), exit-code-INDEPENDENT. Still emit to stdout too (unchanged) — `--output` is an additional sink. `bad_args`/missing-parent-dir on the `--output` path itself → the usual `bad_args` handler.

### Investigation targets

**Required** (read before coding):
- src/agent/run-capture.ts:141 (`parseRunArgs`), :123 (`ParseRunArgsResult`), :152/:168 (value-flag arms to mirror), :49-60 (envelope), :68 (`OUTCOME_EXIT_CODE`).
- src/agent/main.ts:808 (`runRunCaptureSubcommand`), :839 (posture build), :778 (`emitRunCapture` — the `--output` write site).
- src/agent/launch-handle.ts:82 (`LaunchPosture` already has `preset`/`session`), :55 (`tmuxTranscriptSessionId` — `--session` is `--x-tmux-session` grouping, NOT the transcript id, so shared sessions don't collide transcripts).
- src/pair-command.ts:198-221 (`buildPairLaunchArgv` `--x-preset`/`--x-tmux-session` threading — how pair proves this path), :288 (`writeFileAtomic` precedent).
- src/agent/config.ts:521 (`resolvePreset` — for the harness==cli validation).

**Optional** (reference as needed):
- test/agent-run-capture.test.ts (`parseRunArgs` arms + envelope), test/agent-byte-pin.test.ts (`runCommand` pin — new positive arms + the absent-flag regression).

### Risks

- **Byte-stability:** absent `--preset`/`--session`/`--output` MUST leave `agent run`, managed-dispatch (`buildKeeperAgentLaunchArgv`), and `pair send` argv/env byte-identical — the byte-pin is the guard (add an explicit absent-flag pin).
- **`--output` atomicity:** temp file in the SAME dir as the target (EXDEV), named so a poller's final-path match never sees the `.tmp`; write-on-every-outcome (do NOT gate on exit 0).
- **`--preset`/`<cli>` coherence:** validate harness==cli → `bad_args`; do not silently launch a mismatched pair.
- **Dep-graph:** `run-capture.ts` stays db-free; the `--output` atomic write uses `node:fs` only.
- fn-1026 overlaps `parseRunArgs`/`runRunCaptureSubcommand` — the epic hard-deps it; write against the post-fn-1026 code.

### Test notes

`parseRunArgs` arms: `--preset`/`--session` (split + `=`), `--output`, mismatched `--preset`↔`<cli>` → `bad_args`. `--output` atomic-write test (envelope on every outcome incl. a fail outcome; temp+rename; content == the emitted envelope). Byte-pin: positive arm (`agent run --preset X --session Y` carries `--x-preset`/`--x-tmux-session`) + the absent-flag regression (unchanged). No real tmux/subprocess.

## Acceptance

- [ ] `agent run --preset`/`--session` parse (split + `=`), thread into `LaunchPosture`, and `--preset` validates harness == the `<cli>` positional (`bad_args` on mismatch).
- [ ] `agent run --output <path>` writes the 9-key JSON envelope ATOMICALLY (temp+rename) on EVERY outcome, exit-code-independent, in addition to stdout.
- [ ] Absent-flag `agent run` / managed / `pair send` argv byte-identical (byte-pin); dep-graph db-free.
- [ ] `dispatch.ts` help + `cli/agent.ts` header + README document the three flags; `bun test` green.

## Done summary

## Evidence
