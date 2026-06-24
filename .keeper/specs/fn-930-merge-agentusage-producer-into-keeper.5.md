## Description

**Size:** M
**Files:** test/usage-scraper-worker.test.ts (+ any slow test), README.md, CLAUDE.md (= AGENTS.md symlink), the keeperd runtime config

### Approach

Land the integration coverage, cut over, and document — forward-facing only. Tests:
finish the worker's unit suite + a daemon-boot integration assertion; `bun run
test:full` + `bun run test:hygiene` green. Cutover: stop the external `agentusage`
daemon (whatever launches `uv run python daemon.py` today), set the keeperd config
key(s) for the `uv` path + agentusage project dir, restart keeperd, and SOAK — verify
`<id>.json` envelopes keep landing for every account and the picker keeps balancing
(`keeper usage` renders, `picker.json` rotates). Docs: README `## Architecture` gains a
paragraph for the new PRODUCER worker (the existing consumer `usage-worker` stays a
`@parcel/watcher` member — do NOT prune `usage` from the watcher list) + README
`## Install` gains the new config key(s) + a Python-runtime prereq note (an `uv`
project with pexpect/pyte, resolvable by absolute path under the LaunchAgent),
modeled on the `keeper_agent_path` doc; CLAUDE.md gains a terse worker-roster note
for the producer. Document the rollback (unset the config key → worker un-spawns →
restart the external daemon).

### Investigation targets

**Required** (read before coding):
- README.md `## Architecture` worker paragraph (~2692-2709) + `## Install` config block (~403-462, the `keeper_agent_path` doc shape)
- CLAUDE.md worker-roster prose; AGENTS.md is the symlink — edit CLAUDE.md in place
- the keeperd LaunchAgent / runtime config (how the external agentusage daemon is launched today, to stop it)
- scripts/lint-no-real-git.ts + the slow-tier ignore list — keep hygiene green

### Risks

- Doc drift: keep all prose forward-facing (state current behavior, never "formerly the agentusage daemon"); the change-history belongs in the commit message.
- Cutover race: ensure the external daemon is fully stopped before the worker is gated on, or two producers race the same `<id>.json` (the singleton FileLock mitigates, but stop the old one).

### Test notes

`bun run test:full` MANDATORY. Manual soak: with the worker spawned, watch
`~/.local/state/agentusage/` for fresh envelopes across accounts + `picker.json`
rotation over several cycles; confirm `keeper usage` renders live data.

## Acceptance

- [ ] `bun run test:full` + `bun run test:hygiene` green
- [ ] external agentusage daemon stopped; keeperd's worker produces envelopes for every account; the picker balances; `keeper usage` renders live
- [ ] README (Architecture + Install config key + Python prereq) + CLAUDE.md updated, forward-facing; rollback documented
- [ ] soak clean over multiple cycles before declaring done

## Done summary
Tests green (bun run test:full 4325 pass/0 fail + opentui 76 pass; test:hygiene ok) — the worker unit suite + daemon-boot integration assertion landed in .4. Docs updated forward-facing (commit 81934e79): README Architecture gains the usage-scraper PRODUCER worker paragraph + reframes the usage CONSUMER paragraph; README Install gains usage_scraper_uv_path / usage_scraper_project_dir + a uv/pexpect/pyte Python-runtime prereq; CLAUDE.md gains a producer-vs-consumer worker-roster note; rollback documented (unset the config key -> worker un-arms -> restart external daemon). DEFERRED to human observation outside the sandbox: the live cutover (stop arthack.agentusage.daemon LaunchAgent, set the config keys, restart keeperd) + the multi-cycle soak — the scrape needs a real PTY the agent Bash sandbox blocks and /usage is upstream rate-limited.
## Evidence
