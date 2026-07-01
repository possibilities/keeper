## Description

**Size:** M
**Files:** src/pair-command.ts, src/agent/launch-config.ts (new), src/agent/launch-handle.ts,
src/agent/main.ts, src/pair/panel.ts, cli/pair.ts, test/agent-byte-pin.test.ts,
test/agent-launch-handle.test.ts, test/agent-launch-handle-depgraph.test.ts,
test/pair-command.test.ts

### Approach

Behavior-stable relocation of the SHARED launch cluster into a neutral `src/agent/` module.
Nothing is deleted yet; `keeper pair` still works against the relocated symbols.

- **New module `src/agent/launch-config.ts`** (db-free, node-only): move `buildPairLaunchArgv`
  (→ `buildAgentLaunchArgv`), `nativeClaudeArgs`/`nativeCodexArgs`/`nativePiArgs`,
  `stripClaudeEnv`, `PairLaunchOpts` (→ `AgentLaunchOpts`), `PairCli`/`PAIR_CLIS` (→
  `AgentCli`/`AGENT_CLIS`), `READ_ONLY_DIRECTIVE`, `resolvePairKeeperAgentPath` (→
  `resolveKeeperAgentPath` or inline `resolveKeeperAgentPathDepFree`), and the role resolver
  (`loadRolePrompt` + the `<role>.txt` assets, relocated to `src/agent/prompts/`).
- **Update importers** to the new module + names: `src/agent/launch-handle.ts`,
  `src/agent/main.ts`, `src/pair/panel.ts`, and the byte-pin/launch-handle/depgraph tests.
- **`src/pair-command.ts`** keeps ONLY its pair-ONLY symbols for now (`assemblePrompt`,
  `buildPairOutput`/`pairOutputYaml`, `stopTimeoutMsFromSeconds`, `DEFAULT_PAIR_SESSION`) and
  re-imports the moved names as needed so `cli/pair.ts` still compiles + runs byte-stable.
- Keep the depgraph hygiene invariant: `src/agent/launch-config.ts` must be db-free (types-only
  imports); update `test/agent-launch-handle-depgraph.test.ts` to the new module name.

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts: every symbol listed above (definitions + JSDoc) and which are
  SHARED (imported under src/agent) vs pair-ONLY.
- src/agent/launch-handle.ts: the imports from `pair-command` (`buildPairLaunchArgv`,
  `stripClaudeEnv`) — repoint to the new module.
- src/agent/main.ts: the `READ_ONLY_DIRECTIVE` import (+ any launch-cluster use).
- src/pair/panel.ts: imports `PAIR_CLIS`/`PairCli`/`resolvePairKeeperAgentPath` — repoint.
- test/agent-launch-handle-depgraph.test.ts: the module-name pin; test/agent-byte-pin.test.ts +
  test/agent-launch-handle.test.ts: import paths.

**Optional** (reference as needed):
- test/pair-command.test.ts: split — shared-builder tests follow to a new
  `test/agent-launch-config.test.ts`; pair-only tests stay.

### Risks

- **Byte-stability** — the relocated builders must emit IDENTICAL argv/env; golden + pair-cli +
  byte-pin tests stay green. A pure move + rename, no logic change.
- **Dep-graph** — the new module must be db-free; the depgraph test (pointed at the new name)
  stays green.
- **No dangling imports** — after the move, grep for every old `pair-command` import of a moved
  symbol and repoint it; `tsc --noEmit` is the backstop.
- **Role assets** — if the `<role>.txt` files move, update the loader's path resolution.

### Test notes

Move the shared-builder unit tests to `test/agent-launch-config.test.ts` (same assertions, new
import). Keep golden + pair-cli + byte-pin + pair-panel green. `tsc --noEmit` clean. No behavior
change — pure relocation.

## Acceptance

- [ ] The shared launch cluster lives in `src/agent/launch-config.ts` with neutral names; all
  `src/agent/*` + `src/pair/panel.ts` importers compile against it.
- [ ] `src/pair-command.ts` retains only pair-only symbols and still compiles; `keeper pair`
  remains byte-stable (golden + pair-cli green).
- [ ] Depgraph hygiene green (new module db-free); `bun test` + `bun run typecheck` green.

## Done summary

## Evidence
