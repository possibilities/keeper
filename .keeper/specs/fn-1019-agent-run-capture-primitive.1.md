## Description

**Size:** S
**Files:** test/agent-run-capture-golden.test.ts (new), test/agent-byte-pin.test.ts (extend)

### Approach

Lock the current, pre-flattening behavior of the pure pair/agent seams that later increments will move, so a regression in increments 3–6 fails fast. All targets are PURE builders — no subprocess/tmux/git, fully unit-testable per CLAUDE.md test isolation. Pin (via `toEqual` / snapshot) the exact output of: `buildPairLaunchArgv` (per-CLI launch argv), `buildPairOutput` + `pairOutputYaml` (the `--output` YAML shape), the two-line `[keeper-pair] started/completed/failed` Monitor strings emitted by `cli/pair.ts`, `stopTimeoutMsFromSeconds` (the `--timeout`→`--stop-timeout-ms` math, incl. fractional round-up), and `diffGitSnapshots` / `parseGitPorcelain` (the read-only changed-files diff). Separately, extend `test/agent-byte-pin.test.ts` with NEGATIVE assertions that the bare `agent <cli>` and managed `buildAgentwrapLaunchArgv` paths emit NO posture flags — `not.toContain("--read-only")`, `not.toContain("--exclude-tools")`, `not.toContain("--disallowed-tools")`, and no extra `CLAUDE*` env deletes — the byte-stability anchor that guards increments 4–5 from leaking posture onto the managed launch path.

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts:208 (`buildPairLaunchArgv`), :339 (`stopTimeoutMsFromSeconds`), :517/:545 (`diffGitSnapshots`/`parseGitPorcelain`), :608/:639 (`buildPairOutput`/`pairOutputYaml`) — the builders to pin.
- test/agent-byte-pin.test.ts — the existing `toEqual` byte-pin structure to extend with the negative assertions.
- src/exec-backend.ts:840-887 (`buildAgentwrapLaunchArgv`; hardcodes `"claude"` at :863; posture-free) — the managed path the negative assertions cover.
- test/helpers/agent-main-harness.ts — `makeHarness`/`runAndCapture` recording-spawn seam for driving the bare/managed argv.

**Optional** (reference as needed):
- cli/pair.ts — the `emitEvent` `[keeper-pair]` started/completed/failed strings to pin verbatim.

### Risks

- These tests must NOT launch a real process — pin the PURE builders only, never the cross-process `cli/pair.ts` flow end-to-end (CLAUDE.md test isolation forbids subprocess/tmux/git in `bun test`).
- The in-flight `scrub-agentwrap-legacy` rename handoff edits these same files — coordinate identifier names (write against the post-rename names if it lands first) to avoid a textual conflict.

### Test notes

Pure-builder assertions: import the builder, call with fixed inputs, `toEqual` the exact output. Negative byte-pin: drive the harness with a bare/managed launch and assert the composed argv lacks posture flags. No new production code in this task.

## Acceptance

- [ ] Golden tests pin `buildPairLaunchArgv`, `buildPairOutput` + `pairOutputYaml`, the two `[keeper-pair]` Monitor lines, `stopTimeoutMsFromSeconds` (incl. fractional round-up), and `diffGitSnapshots`/`parseGitPorcelain` against exact expected outputs.
- [ ] `test/agent-byte-pin.test.ts` asserts the bare `agent <cli>` and managed `buildAgentwrapLaunchArgv` paths emit no posture flags (no `--read-only`/`--exclude-tools`/`--disallowed-tools`, no extra `CLAUDE*` env deletes).
- [ ] `bun test` green; no test in this task launches a real subprocess/tmux/git.

## Done summary
Added golden characterization pins (test/agent-run-capture-golden.test.ts) for the pure pair/agent builders and extended test/agent-byte-pin.test.ts with negative posture assertions. Test-only; no production change.
## Evidence
