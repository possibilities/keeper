## Description

**Size:** M
**Files:** src/db.ts (config keys + `resolveUsageRoot` env override), src/usage-scrape-runner.ts (new — `ScrapeRunner` seam + invoke/parse), test/helpers/sandbox-env.ts, test/usage-scrape-runner.test.ts (new), test/usage-scrape-runner.slow.test.ts (new), scripts/test-real-git-allowlist.txt (or a sibling allowlist), package.json (slow-tier ignore)

### Approach

Build the seam the worker (`.4`) stands on, and PROVE it end-to-end. (1) Runtime
resolution: add config keys + env overrides for the absolute `uv` path and the
agentusage project dir, resolved like `resolveBuildbotUrl()` (NO-default GATE
variant — the worker spawns ONLY when it resolves; never `fatalExit`). The worker
invocation is `<abs-uv> run --project <agentusage-dir> python -m agentusage.scrape_cli …`
— plain `run`, NEVER `--python <path>` (uv#11288 recreates the venv each call). Both
paths absolute (stripped LaunchAgent PATH). (2) `ScrapeRunner` seam: a thin
`src/usage-scrape-runner.ts` exporting `runScrape(account): Promise<ScrapeResult>` that
`Bun.spawn`s the util, DRAINS stdout concurrently with `proc.exited` via `Promise.all`
(never await-then-read → 64KB pipe deadlock), bounds it with `timeout` + `killSignal:
"SIGKILL"`, reads stderr separately, and parses + validates the discriminated JSON
(asserting `schema_version`). Default-injected real runner; tests pass a synthetic
`ScrapeRunner` returning canned JSON. (3) Test isolation: add a `KEEPER_AGENTUSAGE_ROOT`
env override to `resolveUsageRoot()` (none exists today — it is config-file only), wire
it into `sandboxEnv` as a new state class, and drive the vendored picker's `setStateDir()`
from the same root so the ledger lands in the sandbox. (4) PROOF: a `*.slow.test.ts`
that actually invokes the `.1` util via `uv` and asserts the contract round-trips —
this is where the Bun#24690 empty-stdout-inside-a-Worker hazard is verified on Bun
1.3.14; if it reproduces, the runner spawns from MAIN (documented fallback).

### Investigation targets

**Required** (read before coding):
- src/db.ts:395-397 `resolveBuildbotUrl` (no-default gate template), :354-374 `resolveKeeperAgentPath`, :377-386 `firstNonEmpty`, :450-460 `resolveUsageRoot` (config-only, NO env override), :107 `DEFAULT_AGENTUSAGE_ROOT`, :117-144 `KeeperConfig`, :182-308 parse arm
- test/helpers/sandbox-env.ts:50,:70-79 — the eight state classes to extend
- cli/session-state.ts:33-37,:167 + src/commit-work/git-exec.ts:42,:89 — the injectable-runner (`GitRunner`) seam to mirror for `ScrapeRunner`
- scripts/lint-no-real-git.ts:26-35 + scripts/test-real-git-allowlist.txt + package.json fast-tier `--path-ignore-patterns` — the slow-tier split to mirror for the real-PTY scrape test
- the vendored `setStateDir`/`getStateDir` from `.2`

### Risks

- **KEYSTONE**: this proves three at-risk things at once — `uv` resolving agentusage's project env under the stripped LaunchAgent PATH, Bun#24690 empty-stdout in a Worker, and the JSON contract round-trip. If the worker-thread spawn returns empty stdout, spawn from MAIN; if `uv run` is unreliable under launchd, fall back to a pinned absolute venv. Both isolate here.
- Forgetting the `KEEPER_AGENTUSAGE_ROOT` + picker `setStateDir` wiring means spawn-tests corrupt the human's real `~/.local/state/agentusage/` + `picker.json` — a hard prerequisite for any spawn test.
- The util mutates `~/.claude-profiles/*/.claude.json` trust flags — the slow-test should redirect via a fixture `CLAUDE_CONFIG_DIR` where feasible, or be explicitly gated.

### Test notes

Unit: synthetic `ScrapeRunner` drives the ok/no_subscription/error arms + a
schema_version mismatch, all sandbox-rooted. Slow (`*.slow.test.ts`, allowlisted +
fast-tier-ignored): real `uv` invocation of the `.1` util, asserting the contract
round-trips and stdout is non-empty from the intended spawn location. `bun run
test:full` + `bun run test:hygiene`.

## Acceptance

- [ ] config keys + env overrides resolve an absolute `uv` path + agentusage project dir; the resolver GATES the spawn (resolves → spawn; unresolved → un-spawn + warn, never `fatalExit`)
- [ ] `runScrape` drains stdout concurrently, bounds with `timeout`+SIGKILL, parses + validates the discriminated contract; a synthetic `ScrapeRunner` stubs it in unit tests
- [ ] `KEEPER_AGENTUSAGE_ROOT` overrides `resolveUsageRoot()`, is wired into `sandboxEnv`, and drives the vendored picker `setStateDir()`; no test touches the real state dir
- [ ] a `*.slow.test.ts` proves the keeper→`uv`→util→JSON round-trip with non-empty stdout (Bun#24690 verified on 1.3.14); allowlisted + fast-tier-ignored; `test:hygiene` green

## Done summary
Built the keeper→uv→agentusage scrape seam: ScrapeRunner with concurrent stdout drain + SIGKILL timeout + discriminated JSON validation, db config keys + no-default gate resolver for the absolute uv path/project dir, KEEPER_AGENTUSAGE_ROOT test-isolation override, and a slow test proving the real uv round-trip (incl. the in-Worker Bun#24690 hazard does NOT reproduce on Bun 1.3.14).
## Evidence
