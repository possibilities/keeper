## Description

**Size:** S
**Files:** src/agent/run-capture.ts, src/agent/main.ts, src/agent/launch-handle.ts, src/agent/launch-config.ts, test/agent-run-capture.test.ts, test/agent-launch-config.test.ts, test/agent-run-capture-golden.test.ts, README.md

### Approach

Add a `--name <value>` / `--name=<value>` parse arm to `parseRunArgs` mirroring the `--session`/`--output` two-arm pattern (bare form reads `rest[i+1]` with an undefined guard, `=` form slices); add `name: string | null` to the ok-branch of `ParseRunArgsResult` and the return object. Thread `parsed.name` through `runRunCaptureSubcommand`'s posture into `launchToResolvedHandle` → `buildAgentLaunchArgv`: the name lands on the tmux window name for EVERY harness (the `--x-tmux-window-name`/`options.windowName` knob), and additionally on the harness-native name flag only where the harness has one (claude and pi do; codex does not — a native-only mapping would break codex legs). Match the interactive path's suppression semantics: an explicit name suppresses any auto-mint. Note the run path today reaches `launchKeeperAgentInTmux` directly via `launchToResolvedHandle` and never passes the interactive auto-mint block, so this is new naming behavior on that path, not a suppression rewire — do not add a dead guard. Keep `--name` emptiness handling consistent with `--session` (no special empty rejection in the parser).

A prompt positional beginning with `--` still parses as an unknown flag — a pre-existing trap, explicitly out of scope here; do not "fix" it in passing.

### Investigation targets

**Required** (read before coding):
- src/agent/run-capture.ts:283-311 — the `--session`/`--output` parse arms to mirror, and the unknown-flag catch-all that currently kills panel legs
- src/agent/main.ts:921,1042-1057 — where parsed fields thread into the launch posture
- src/agent/launch-handle.ts:149-171 — `launchToResolvedHandle`, and how the run path names (or fails to name) its window today
- src/agent/launch-config.ts:163-194 — `buildAgentLaunchArgv` wrapperFlags assembly
- src/agent/tmux-launch.ts:318-326,647-651 — the window-name knob (`options.windowName`, `-n`), distinct from the harness-native `--name`
- src/pair/panel.ts:487-503 — `buildPanelLegArgv`, the producer of the argv this must accept

**Optional** (reference as needed):
- src/agent/main.ts:2147-2168 — interactive auto-mint precedent (hasFlagToken suppression)
- src/agent/passthrough.ts:82,147 — `--name` in the claude passthrough sets

### Risks

- The byte-pin goldens (`test/agent-launch-config.test.ts:60`, `test/agent-run-capture-golden.test.ts:19`) pin `buildAgentLaunchArgv` output with full-array `.toEqual` — update deliberately, not by copy-paste of the new actual
- `test/pair-panel.test.ts:217` asserts no banned tokens on the leg argv — the threaded name must not trip it

### Test notes

The keystone test is the round-trip: feed `buildPanelLegArgv(...)` output for each harness (claude, codex, pi) through `splitSubcommand` + `parseRunArgs` and assert `ok: true` with `name === "panel::<slug>::<preset>"` — it must be red against pre-change source. Extend `okParse` (test/agent-run-capture.test.ts:172-192) with a `name: null` default. Add window-name threading assertions through the stubbed MainDeps harness (`test/helpers/agent-main-harness.ts`, `flagValues`/`nameArg` helpers). Update README's `agent run` flag enumeration (~line 1454) in the same sentence-continuation prose style.

## Acceptance

- [ ] `parseRunArgs` accepts both `--name` spellings and returns the value; unknown-flag behavior for everything else unchanged
- [ ] Round-trip test (buildPanelLegArgv → splitSubcommand → parseRunArgs) exists for all three harnesses and passes
- [ ] The name reaches the tmux window name for all harnesses, and the native name flag only for claude/pi; codex legs carry no native `--name`
- [ ] Goldens updated; full fast suite green

## Done summary
agent run now accepts --name/--name=, threading the value onto the tmux window name for every harness and the native --name for claude/pi (codex has none). Added a buildPanelLegArgv->splitSubcommand->parseRunArgs round-trip guard across all three harnesses so the builder and parser can never silently drift again.
## Evidence
