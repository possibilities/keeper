## Description

**Size:** M
**Files:** src/agent/launch-handle.ts (new; or co-locate in src/agent/run-capture.ts — your call, keep it db-free), src/agent/main.ts

### Approach

Extract the launch→`ResolvedHandle` glue that `agent run` uses — `launchForRunCapture` (`src/agent/main.ts:747-801`) plus the private `tmuxTranscriptSessionId` (`main.ts:530-548`) — into ONE exported, db-free helper that both `agent run` and (next task) `pair send` call. Parameterize it by posture options + explicit launch deps: the `buildPairLaunchArgv` opts (`readOnly`, `preset`, `model`, `effort`, `session`, `prompt`) plus the launch deps (`tmuxBin`, `launcherStateDir`, `env`, `cwd`, `randomUuid`, `launcherArgvPrefix`, `runTmuxCommand`, `now`), so the posture-free `agent run` (`readOnly:false`) and the posture-full pair caller both express their config through the same seam. Internals: `buildPairLaunchArgv` → `parseKeeperAgentTmuxArgs` → session-id mint (`agent === "codex" ? null : randomUuid()`) → `launchKeeperAgentInTmux` → construct the local `ResolvedHandle` (sessionId, transcriptPath:null, stopTimeoutMs) → `{ok, handle, runId}`; catch `TmuxLaunchError` → `{ok:false}`. Repoint `runRunCaptureSubcommand` (`main.ts:808-832`) to call the extracted helper. Keep `agent run` BYTE-STABLE.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:747-801 (`launchForRunCapture` — the prototype to extract), :530-548 (`tmuxTranscriptSessionId` — co-extract/export), :808-832 (`runRunCaptureSubcommand` — repoint), :700-706 (`runCaptureSeams`).
- src/agent/tmux-launch.ts:468 (`launchKeeperAgentInTmux`), :196 (`parseKeeperAgentTmuxArgs`), :95 (`TmuxLaunchError`), :700/:360/:368 (`resolveTmuxBin`/`defaultKeeperAgentStateDir`/`defaultTmuxCommandRunner` — the launch deps).
- src/agent/pair-subcommands.ts:27-41 (`ResolvedHandle` shape), :221-224 (`VerbDeps`).
- src/agent/run-capture.ts:14-18 (dep-graph discipline — the helper stays db-free).

**Optional** (reference as needed):
- test/agent-run-capture.test.ts:69-80 (seam-injection test pattern), test/agent-byte-pin.test.ts (agent-run byte-pin), test/agent-run-capture-golden.test.ts (keep green), test/agent-run-capture-depgraph.test.ts (the hygiene grep to clone).

### Risks

- **Dep-graph:** the new helper (and wherever it lives) must stay db-free (no `src/db.ts`/`bun:sqlite`) — extend/clone the `agent-run-capture-depgraph` hygiene test for it.
- **Byte-stability:** `agent run` must stay byte-stable through the extraction — the existing agent-run + byte-pin + golden tests are the guard; do not change `agent run`'s observable behavior.
- **fn-1020 overlap:** `main.ts` churn overlaps fn-1020's env-var rename — the epic deps on fn-1020, so this lands after; write against the post-rename `main.ts` identifiers.
- **Seam clarity:** the posture-options-bag parameterization must not obscure the two callers' configs — keep the seam minimal (the `buildPairLaunchArgv` opts + the explicit launch deps only).

### Test notes

Unit-test the extracted helper via an injected `runTmuxCommand` (force launch success + `TmuxLaunchError`) — mirror `test/agent-run-capture.test.ts`; no real tmux. Keep agent-run + byte-pin + golden tests green.

## Acceptance

- [ ] A single exported, db-free launch→`ResolvedHandle` helper exists, parameterized by posture opts + explicit launch deps; both posture-free and posture-full configs flow through it.
- [ ] `agent run`'s handler (`runRunCaptureSubcommand`) is repointed to the helper and stays byte-stable (agent-run, byte-pin, and golden tests green).
- [ ] `tmuxTranscriptSessionId` is co-extracted/exported as needed; the helper is unit-tested via an injected tmux runner (success + `TmuxLaunchError`) with no real tmux.
- [ ] A dep-graph hygiene test pins the helper's module db-free.
- [ ] `bun test` green.

## Done summary

## Evidence
