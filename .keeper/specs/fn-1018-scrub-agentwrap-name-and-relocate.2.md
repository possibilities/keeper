## Description

**Size:** M
**Files:** src/exec-backend.ts, src/agent/{main,args,dispatch,tmux-launch,state-sharing}.ts, src/daemon.ts, cli/{dispatch,pair,keeper}.ts, scripts/{restore-agents,resume}.ts, src/{bus-wake,handoff-worker,autopilot-worker,restore-worker,resume-descriptor,reducer,usage-flock}.ts, src/pair-command.ts, README.md, test/fixtures/agentwrap-launch-stdout.jsonl (rename), ~30 test files. EXCLUDES src/agent/config.ts, src/agent/plugins.ts, test/agent-config.test.ts (owned by .3), and every frozen survivor.

### Approach

One atomic, no-behavior-change sweep making keeper say `keeper agent`. Two passes (practice-scout): (1) rename internal symbols with strings/comments OFF; (2) intentional prose/string updates. Naming: launch-transport family → `keeperAgent*` / `KeeperAgent*` / `KEEPER_AGENT_*` (matches existing `resolveKeeperAgentPath`); in-`src/agent/` parsed-arg/deps flag fields → `launcher*`.

RENAME — functions: `agentwrapLaunch`→`keeperAgentLaunch`, `buildAgentwrapLaunchArgv`→`buildKeeperAgentLaunchArgv`, `parseAgentwrapStdout`→`parseKeeperAgentStdout`, `mapAgentwrapExit`→`mapKeeperAgentExit`, `parseAgentwrapTmuxArgs`→`parseKeeperAgentTmuxArgs`, `launchAgentwrapInTmux`→`launchKeeperAgentInTmux`, `resolveAgentwrapBin`→`resolveKeeperAgentBin`, `defaultAgentwrapStateDir`→`defaultKeeperAgentStateDir` (FREEZE the returned `~/.local/state/agentwrap` path), `ensureAgentwrapProfileDir`/`ensureAgentwrapPiProfileDir`→`ensureKeeperAgent*`, `normalizeAgentwrapProfileArg`→`normalizeKeeperAgentProfileArg`, `hasAgentwrapHelpFlag`→`hasKeeperAgentHelpFlag`, `runAgentwrap`→`runKeeperAgent`. Types: `AgentwrapLaunchOpts`/`Deps`/`ParseResult`→`KeeperAgent*`, `AgentwrapProbeFn`/`AgentwrapProbeResult`→`KeeperAgent*`. Consts: `AGENTWRAP_SCHEMA_VERSION`/`PAIR_AGENTWRAP_SCHEMA_VERSION`→`KEEPER_AGENT_SCHEMA_VERSION`/`PAIR_KEEPER_AGENT_SCHEMA_VERSION` (NAME only — the JSON wire key `schema_version` is unchanged), `AGENTWRAP_TMUX_EXIT`→`KEEPER_AGENT_TMUX_EXIT`, `AGENTWRAP_CAPTURE_TIMEOUT_MS`→`KEEPER_AGENT_CAPTURE_TIMEOUT_MS`, `AGENTWRAP_HELP`→`KEEPER_AGENT_HELP`, `AGENTWRAP_HELP_FLAG`→`KEEPER_AGENT_HELP_FLAG` (value `--x-help` stays), test consts `AGENTWRAP_OK_LINE`/`AGENTWRAP_FIXTURE_STDOUT`→`KEEPER_AGENT_*`, `makeAgentwrapSpawnStub`→`makeKeeperAgentSpawnStub`. In-`src/agent/` flag fields → `launcher*`: `agentwrapVerbose`/`VeryVerbose`/`NoConfirm`/`Profile`/`CodexSessionName`/`Preset`, `explicitAgentwrapProfile`→`explicitLauncherProfile`, `deps.agentwrapStateDir`→`deps.launcherStateDir`, `ensureAgentwrap{,Pi}ProfileDirFn`→`ensureKeeperAgent*Fn`, locals `parsingAgentwrap*`→`parsingLauncher*`. Rename the fixture FILE → `keeper-agent-launch-stdout.jsonl` + its loader URL, but KEEP its content's `~/.local/state/agentwrap/` paths verbatim.

SCRUB prose/user-facing → "keeper agent"/"the launcher": comments; `AGENTWRAP_HELP`/`USAGE`/`VERSION` body text; error prefix `agentwrap:`→`keeper agent:`; pair error strings; run.json `command:["agentwrap",...]`→`["keeper","agent",...]`; default tmux session name `"agentwrap"`→`"keeper-agent"` (tmux-launch.ts:767); the "Started agentwrap in tmux window" message; README prose + the line-1426 flag bug (`--agentwrap-preset`→`--x-preset`).

FREEZE — never touch: the `AGENTWRAP_*` env-var NAME strings + the `startsWith("AGENTWRAP_")` filter; `~/.local/state/agentwrap` path; `legacyAgentwrapPresetsPath` + its path; the `schema_version` JSON key; the retired-alias test literals. Never `sed -i 's/agentwrap/.../g'` — rename per-symbol, word-bounded.

### Investigation targets

**Required** (read before coding):
- scripts/frozen-allowlist.txt (from .1) — the machine-checkable freeze list
- src/exec-backend.ts:739-1062 — the transport family (the bulk, 83 refs)
- src/agent/args.ts:22-135 — the `launcher*` flag fields
- src/agent/main.ts (highest density, 91 refs), src/agent/dispatch.ts:35-157 (HELP/USAGE/VERSION strings)
- src/keeper-agent-path.ts + src/db.ts:353 — the `keeperAgent*` casing precedent
- test/exec-backend.test.ts (112 refs), test/agent-tmux-launch.test.ts (42), test/agent-profile-bootstrap.test.ts (30), test/agent-args.test.ts (28)

**Optional** (reference as needed):
- README.md:1426,3310-3715 — prose + flag-bug

### Risks

- The `AGENTWRAP_` prefix collision: transport consts (`AGENTWRAP_SCHEMA_VERSION`, `AGENTWRAP_TMUX_EXIT`, `AGENTWRAP_CAPTURE_TIMEOUT_MS`, `AGENTWRAP_HELP`, `AGENTWRAP_HELP_FLAG`, `AGENTWRAP_OK_LINE`, `AGENTWRAP_FIXTURE_STDOUT`) RENAME; the env-var family FREEZES. Split by exact symbol, never by prefix.
- The test-assertion trap: a green suite does NOT prove a clean sweep. After the sweep, run `bash scripts/lint-retired-name.sh` AND `git grep -iE '\bagentwrap\b'` over the tree (minus `.keeper`, `scripts/frozen-allowlist.txt`, and the `.3`-owned files) and hand-review every hit — only frozen survivors may remain.
- Atomicity: the ~400 test refs share the transport types + fixture, so the rename + tests land in ONE commit; the suite is red between passes.

### Test notes

`bun test` green; `bash scripts/lint-retired-name.sh` green (no survivor clobbered); the grep-clean check shows only frozen survivors.

## Acceptance

- [ ] All in-scope identifiers renamed per the `keeperAgent*`/`launcher*` scheme; all call sites + ~400 test refs updated; suite green in one commit
- [ ] Fixture renamed (file + loader); its frozen content paths preserved
- [ ] All prose/comments/help/error/README strings say "keeper agent"/"the launcher"; line-1426 flag bug fixed
- [ ] frozen-anchor lint green; `git grep -iE '\bagentwrap\b'` shows only pinned survivors (env family, state dir, legacy detector, retired-alias tests)
- [ ] src/agent/config.ts, src/agent/plugins.ts, test/agent-config.test.ts untouched (owned by .3)

## Done summary
Atomic agentwrap->keeper agent name sweep: renamed launch-transport symbols to keeperAgent*/KEEPER_AGENT_* and launcher flag fields to launcher*, renamed the launch-stdout fixture, scrubbed all prose/help/error/README strings to keeper agent/the launcher, and fixed the --agentwrap-preset doc bug to --x-preset. Preserved the frozen AGENTWRAP_* env family, state dir, legacy detector, and retired-alias tests. Frozen-anchor lint green; full suite 5034 pass/0 fail.
## Evidence
