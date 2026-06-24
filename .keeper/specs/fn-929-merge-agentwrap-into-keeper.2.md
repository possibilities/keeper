## Description

**Size:** M
**Files:** src/agent/tmux-launch.ts (vendored), src/agent/main.ts (vendored), src/db.ts (config-aware resolver), a new dep-free path helper (e.g. src/keeper-agent-path.ts), src/pair-command.ts, test/agent-self-invoke.test.ts (new), test/agent-self-invoke.slow.test.ts (new)

### Approach

Replace agentwrap's `resolveAgentwrapBin(process.argv[1])`-derived re-exec with
an explicit `launcherArgvPrefix`. The detached pane's launch script (agentwrap
`tmux-launch.ts` `buildLaunchScript` ~:800-822, today embeds
`[bunBin, agentwrapBin, ...argv]`) must instead embed
`[<abs bun>, <abs cli/keeper.ts>, "agent", <agent>, ...innerArgs]`. Compute the
prefix from a NEW resolver, NOT `process.argv[1]` (which is `daemon.ts` in
keeperd, `cli/keeper.ts` in the CLI — neither carries the `agent` token).
Provide two resolver variants mirroring the existing split: a config-aware
`resolveKeeperAgentPath` in `src/db.ts` (clone the `resolveAgentwrapPath` shape
at :302; add `KeeperConfig.keeperAgentPath` ~:134 + parse ~:234; env
`KEEPER_AGENT_PATH` > config `keeper_agent_path` > derived default), and a
`db.ts`-FREE variant for the cold-start / pair path mirroring
`resolvePairAgentwrapPath` (:632) — env + a dep-free default deriving the abs
`cli/keeper.ts` path WITHOUT importing `src/db.ts`. The default must be an
absolute, `path.resolve`'d, symlink-resolved path (neutralizes PATH-injection
AND survives keeperd's stripped LaunchAgent PATH). Keep `KEEPER_AGENTWRAP_PATH`
/ `agentwrap_path` readable as deprecated aliases.

### Investigation targets

**Required** (read before coding):
- ~/code/agentwrap/src/tmux-launch.ts (buildLaunchScript self-reexec embed ~:800-822, resolveAgentwrapBin ~:704-714), src/main.ts (bunBin/agentwrapBin MainDeps wiring ~:185-189)
- src/db.ts:302 resolveAgentwrapPath, :234 config parse, :134 KeeperConfig, :110 default — the resolver template
- src/pair-command.ts:632 resolvePairAgentwrapPath — the db.ts-free variant template

**Optional** (reference as needed):
- README ~:446 — config doc for the new key

### Risks

- THE load-bearing silent regression: if the pane re-execs the wrong binary (`daemon.ts` / external agentwrap / a relative path), the launch JSON still returns SUCCESS — the failure is invisible until the K=3 never-bound breaker trips. The integration test MUST assert the pane's ACTUAL command, not just JSON success.
- The cold-start resolver cannot import `src/db.ts` — deriving the keeper cli abs path dep-free is the tricky part (use `import.meta` / a known install path, with `KEEPER_AGENT_PATH` override).
- keeperd's stripped LaunchAgent PATH lacks `~/.bun/bin` — the embedded `bun` + keeper paths must be absolute.

### Test notes

Integration (`*.slow.test.ts`): spawn a detached launch, read back the launch
script / pane command, assert it re-execs `… cli/keeper.ts agent claude …`.
Unit: byte-pin the `launcherArgvPrefix` for BOTH the daemon-context and
CLI-context callers (synthetic `argv[1]` both ways) → identical prefix.

## Acceptance

- [ ] the detached pane re-execs `[bun, <abs cli/keeper.ts>, agent, …]` — verified by an integration test reading the ACTUAL pane command, identical whether spawned from keeperd (`argv[1]`=daemon.ts) or the CLI
- [ ] `resolveKeeperAgentPath` (config-aware) + a `db.ts`-free cold-start variant both resolve an absolute symlink-resolved path; `KEEPER_AGENT_PATH` / `keeper_agent_path` override
- [ ] the cold-start variant imports no `src/db.ts` (hygiene / grep proof)
- [ ] `KEEPER_AGENTWRAP_PATH` / `agentwrap_path` still read as deprecated aliases

## Done summary

## Evidence
