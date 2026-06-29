## Description

**Size:** S
**Files:** src/db.ts, src/keeper-agent-path.ts, src/pair-command.ts, README.md, test/config.test.ts, test/agent-self-invoke.test.ts, test/pair-cli.test.ts, test/pair-command.test.ts

Remove the deprecated agentwrap alias scaffolding left after the launcher folded into `keeper agent`. All edits land in ONE commit — the code, tests, and README must change together or the suite breaks mid-sequence (a test importing a removed symbol fails to compile). Scope STRICTLY to the named symbols below; this is a symbol removal, not a string sweep.

### Approach

1. **src/db.ts** — remove the dead resolver and the alias arms:
   - Delete `DEFAULT_AGENTWRAP_PATH` (~:124-126), the `agentwrapPath?` field + its docblock (~:164-170), the parse-layer `let agentwrapPath` (~:259-263), the `agentwrap_path` parse block (~:334-341), `agentwrapPath` in the returned config object (~:402), and the entire `resolveAgentwrapPath()` function (~:410-433).
   - In `resolveKeeperAgentPath()` drop `process.env.KEEPER_AGENTWRAP_PATH` and `cfg.agentwrapPath` from the `firstNonEmpty(...)` chain (~:455-456), leaving `firstNonEmpty(process.env.KEEPER_AGENT_PATH, cfg.keeperAgentPath)`.
   - Re-aim (don't just delete) the now-stale comments to state the surviving precedence with NO alias mention: the `resolveKeeperAgentPath` precedence docblock (~:442-447), the `keeperAgentPath` field comment "Supersedes agentwrapPath…" (~:174-176), and the parse comment "falls back to agentwrap_path (deprecated alias)" (~:343-345).
2. **src/keeper-agent-path.ts** — drop `?? env.KEEPER_AGENTWRAP_PATH` at ~:68 so it reads `const override = env.KEEPER_AGENT_PATH;`. Re-aim the precedence docblocks (~:18-23 header, ~:57-59 depfree) to the two-link form (`KEEPER_AGENT_PATH` env > derived default), no alias.
3. **src/pair-command.ts** — re-aim the `resolvePairKeeperAgentPath` docblock (~:680-683) to remove the `KEEPER_AGENTWRAP_PATH (deprecated alias) >` line.
4. **README.md** — delete ONLY the one sentence at ~:442 ("The `agentwrap_path` config key and `KEEPER_AGENTWRAP_PATH` env are still read as a deprecated alias."); keep the surrounding paragraph (435-448) intact. Leave every other `agentwrap`/`agentwrapLaunch` README mention (the live transport docs) untouched.
5. **Tests** — two flavors:
   - DELETE the dead cases: in `test/config.test.ts` the `resolveAgentwrapPath` import (~:18), the `resolveAgentwrapPath` + `agentwrapPath`-field test block (~:66-111, plus field assertions ~:130-133), and the now-dead `prevAgentwrapEnv` save/restore (~:30-31, ~:41-43); re-aim the file header comment (~:2) that mis-describes the file as about `exec_backend`. In `test/agent-self-invoke.test.ts` delete the deprecated-alias cases (the depfree alias + "wins over alias" cases ~:77-96, and the config-aware alias case ~:149-156) and drop `KEEPER_AGENTWRAP_PATH` from the `withEnv` key list (~:119).
   - REPOINT (not delete) the two failure-injection tests from `KEEPER_AGENTWRAP_PATH` to `KEEPER_AGENT_PATH`: `test/pair-cli.test.ts` (docblock ~:10, `TOUCHED_ENV_KEYS` ~:49, sandboxEnv `extra` ~:78) and `test/pair-command.test.ts` (the deprecated-alias assertion ~:701-707 + its test name). Both still drive the same launch-failure branch via a nonexistent binary.
6. **Add a regression guard** mirroring the `exec_backend` precedent: a test that parses a config carrying `agentwrap_path:` and asserts the resolved config has no `agentwrapPath` property (boots clean, key silently ignored). Put it in `test/config.test.ts` next to the `exec_backend` `not.toHaveProperty` guard.
7. **Optionally** keep one negative assertion that a stray `KEEPER_AGENTWRAP_PATH` is now ignored by `resolveKeeperAgentPath` (proves the arm is truly gone, not half-removed).
8. Run `bun run test` (full suite) green, then commit via `keeper commit-work` with a `chore(agent):` scope.

### Investigation targets

**Required** (read before coding):
- src/db.ts:124-126, 164-177, 259-263, 334-345, 402, 410-469 — the dead resolver, the alias-arm parse plumbing, and the LIVE `resolveKeeperAgentPath` whose precedence must be preserved.
- src/keeper-agent-path.ts:18-23, 57-74 — the depfree resolver + docblock to trim.
- src/pair-command.ts:677-690 — the pair resolver docblock (delegates to the depfree leaf).
- test/config.test.ts:1-52, 66-111, 130-133 — the tests to delete AND the `exec_backend` regression-guard pattern (~:54) to mirror for the new `agentwrap_path` guard.
- test/agent-self-invoke.test.ts:57-165 — the depfree + config-aware resolver tests (delete alias cases, keep `KEEPER_AGENT_PATH` cases).
- test/pair-cli.test.ts:46-90 — `TOUCHED_ENV_KEYS` + `sandboxEnv({extra})` shape to repoint.
- test/pair-command.test.ts:692-710 — the `resolvePairKeeperAgentPath` test to repoint.

**Optional** (reference for the scope boundary — DO NOT edit):
- src/agent/main.ts:321 — the LIVE `AGENTWRAP_CLAUDE_PROFILE` env (NOT the path alias).
- src/exec-backend.ts — the LIVE `agentwrapLaunch` transport (~50 legitimate `agentwrap` refs).
- test/db.test.ts:5605-5620, test/keeper-cli.test.ts:949 — `exec_backend` regression guards (KEEP).
- test/daemon.test.ts:3579 — asserts the boot warning names the live `KEEPER_AGENT_PATH` (KEEP).

### Risks

- **Over-deletion is the #1 risk.** "agentwrap" is a live identifier in ~52 files; only the named symbols above are in scope. Do NOT touch `src/agent/*`, `cli/agent.ts`, `AGENTWRAP_CLAUDE_PROFILE`, `src/exec-backend.ts`, the `exec_backend` regression guards, or `.keeper/` specs.
- **Precedence regression.** Stripping the alias arms must not change the surviving `KEEPER_AGENT_PATH > keeper_agent_path > derived-default` order; the kept tests are the guardrail.
- **Atomicity.** Code + tests + README in ONE commit; a partial commit leaves the suite red (a test importing a removed symbol).

### Test notes

- `bun run test` (full suite, routes through `scripts/test-gate.ts`) must be green before commit.
- Tests follow the isolation rule — `sandboxEnv(...)`, no daemon/socket/git. The repointed pair tests keep their existing `sandboxEnv({extra})` shape.
- Final dead-ref check before commit: `grep -rn 'resolveAgentwrapPath\|DEFAULT_AGENTWRAP_PATH\|KEEPER_AGENTWRAP_PATH\|agentwrap_path' src/ cli/` returns nothing.

## Acceptance

- [ ] `resolveAgentwrapPath` and `DEFAULT_AGENTWRAP_PATH` removed; `grep -rn 'resolveAgentwrapPath\|DEFAULT_AGENTWRAP_PATH' src/ cli/` is empty.
- [ ] `KEEPER_AGENTWRAP_PATH`, `agentwrap_path`, and `cfg.agentwrapPath` removed from all three live resolvers and the config parse; `grep -rn 'KEEPER_AGENTWRAP_PATH\|agentwrap_path\|agentwrapPath' src/ cli/` is empty.
- [ ] `resolveKeeperAgentPath` / `resolveKeeperAgentPathDepFree` preserve the `KEEPER_AGENT_PATH > keeper_agent_path > derived-default` precedence (kept tests pass).
- [ ] The README deprecation sentence (~:442) is removed and its paragraph still reads cleanly.
- [ ] Deprecated-alias tests deleted; `test/pair-cli.test.ts` and `test/pair-command.test.ts` repointed to `KEEPER_AGENT_PATH` and passing.
- [ ] A regression guard asserts a config with `agentwrap_path` boots clean (no `agentwrapPath` property), mirroring the `exec_backend` guard.
- [ ] The live launcher identity is untouched (`src/agent/*`, `cli/agent.ts`, `AGENTWRAP_CLAUDE_PROFILE`, `src/exec-backend.ts`, the `exec_backend` guards, `.keeper/`).
- [ ] `bun run test` full suite green; committed via `keeper commit-work`.

## Done summary
Removed all deprecated agentwrap path-alias scaffolding (resolveAgentwrapPath, DEFAULT_AGENTWRAP_PATH, KEEPER_AGENTWRAP_PATH/agentwrap_path arms) from the three live keeper-agent-path resolvers + config parse, repointed/deleted the alias tests, added an agentwrap_path silent-ignore regression guard, and dropped the stale README sentence. Full suite green.
## Evidence
