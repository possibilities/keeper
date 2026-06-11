## Description

**Size:** M
**Files:** package.json, tsconfig.json, biome.json, .claude-plugin/plugin.json, lib/keeper-compat.ts (new), lib/state.ts, performance/watch.ts, performance/watchdog.ts, agents/performance.md, commands/babysit-init.md, commands/babysit-triage.md, FINDINGS-LEDGER.md

### Approach

Scaffold `~/code/sitter` as a Bun repo mirroring keeper's configs
(package.json with `private:true` + the same devDependencies — biome
2.2.0, @types/bun, bun-types, typescript — tsconfig with sitter's own
`include`, biome.json copied as-is). The repo root IS the plugin
(keeper's pattern): flatten `babysitters/*` to the root —
`.claude-plugin/`, `agents/`, `commands/`, `lib/`, `performance/`.
Copy-only: nothing is deleted from keeper in this task.

Create `lib/keeper-compat.ts`, the single vendored-contract module:
the five path resolvers (resolveDbPath/SockPath/DeadLetterDir/
EventsLogDir/BackstopLogPath — pure homedir/join over KEEPER_* env),
`atomicWriteFile`, `parsePlanRef` + `ParsedPlanRef` + `PLAN_REF_RE`,
`computeStats` + StatsRow/StatsResult + the four type aliases from
`src/backstop-telemetry.ts` (BackstopClass/Name/Record/Rollup), and a
local `openDbReadonly(path)` replacing keeper's `openDb`:
`new Database(path, { readonly: true })` + the connection-local read
pragmas (busy_timeout, journal_mode=WAL, synchronous=NORMAL,
foreign_keys=ON, temp_store=MEMORY, mmap_size) + `PRAGMA query_only=ON`.
It must prepare NO statements (keeper's openDb throws "no such column"
on a skewed DB before returning — the scanner must tolerate skew) and
preserve the missing-file behavior the tick relies on (tick already
early-returns on missing DB; the opener may throw on a vanished file —
scan's existing degrade posture covers it). No bootRetry: a failed
300s tick self-heals next interval.

Rewire watch.ts/watchdog.ts imports from `../../src/*` and
`../../scripts/*` to `../lib/keeper-compat`. Strip the NUL byte
(~offset 9796) from watch.ts during the copy.

Split the spawn config into TWO per-sitter knobs (a module-scope
config record per sitter): `agentCwd` — the spawned triage agent's
cwd, stays `/Users/mike/code/keeper` (the agent greps keeper code and
runs `keeper`/`planctl`) — and `pluginDir` — the `--plugin-dir`, now
the sitter repo root. These are different repos after the move;
conflating them breaks every escalation. Rename the plugin
`babysitters` → `sitter` at its three coupling points: plugin.json
`name` (+ verb-phrase `description` per ~/code/CLAUDE.md manifest
convention), `TRIAGE_AGENT = sitter:${SLUG}`, and the spawn prompt
text naming the agent_type. Keep `BABYSITTER_STATE_DIR` and the
`~/.local/state/babysitters/<slug>` layout EXACTLY as-is — live state
(seen.json, heartbeat.json, backstop-baseline.json) carries over.

Repoint the two command files' hardcoded
`~/code/keeper/babysitters/{FINDINGS-LEDGER.md,agents/$0.md}` refs to
the sitter repo paths.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:78-98 — the exact keeper import block to replace
- babysitters/performance/watch.ts:2289-2301 — REPO_ROOT / BABYSITTERS_PLUGIN_DIR / TRIAGE_AGENT constants
- babysitters/performance/watch.ts:2331-2385 — spawnAgentLive (consumes all three)
- babysitters/performance/watch.ts:1512-1523 — scan's openDb call (the readonly+prepareStmts:false contract)
- src/db.ts:1070-1089 — applyPragmas, the model for openDbReadonly
- src/db.ts:51,60,316,331,344,3607 — the resolvers + atomicWriteFile to vendor
- src/derivers.ts:306-340 — PLAN_REF_RE + ParsedPlanRef + parsePlanRef
- scripts/backstop-stats.ts:117 — computeStats + its src/backstop-telemetry type imports

**Optional** (reference as needed):
- babysitters/lib/state.ts — moves as-is (zero keeper imports)
- keeper package.json / tsconfig.json / biome.json — scaffolding templates
- commands/babysit-init.md, commands/babysit-triage.md — the keeper-path refs to repoint

### Risks

- watch.ts is binary-flagged to grep (NUL byte) — use `rg -a` / Read when
  editing; verify the strip didn't alter code.
- fn-792 lands a followup-writer into `babysitters/lib/` and rewrites
  watch.ts escalation paths first — copy from post-fn-792 HEAD, and pick
  up whatever lib/ modules exist at copy time.
- The vendored copy is an intentional fork, not a mirror — do not
  "improve" the proven readonly-open settings.

### Test notes

Proof: `bun run performance/watch.ts --json` from `~/code/sitter`
produces a findings envelope against the live keeper.db;
`rg -l "code/keeper/src|\.\./src/" --glob '*.ts'` finds nothing;
`biome check` clean. Full test port is task 2.

## Acceptance

- [ ] `bun run performance/watch.ts --json` works from ~/code/sitter against the live DB
- [ ] Zero keeper-source imports anywhere in sitter (rg fence check passes)
- [ ] `claude --plugin-dir ~/code/sitter` resolves the `sitter:performance` agent
- [ ] agentCwd and pluginDir are independent per-sitter config; agentCwd defaults to /Users/mike/code/keeper
- [ ] biome clean; plugin manifest carries a verb-phrase description
- [ ] keeper tree untouched (copy-only)

## Done summary

## Evidence
