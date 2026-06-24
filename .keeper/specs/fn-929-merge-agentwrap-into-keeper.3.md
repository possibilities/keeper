## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, cli/dispatch.ts, src/dispatch-command.ts, src/pair-command.ts, cli/pair.ts, src/daemon.ts, src/db.ts, test/exec-backend.test.ts

### Approach

Repoint every launch consumer from spawning the external agentwrap binary to
`keeper agent …`. The central seam: `src/exec-backend.ts`
`buildAgentwrapLaunchArgv` (:952) → emit `[<resolved keeper path>, "agent",
<agent>, …]`; `agentwrapLaunch` (:1137) keeps its shape, so
`autopilot-worker.ts:1848` and `cli/dispatch.ts:395-405` ride the seam
unchanged. Repoint pair's own surface: `src/pair-command.ts` `buildPairLaunchArgv`
(:192) / `buildWaitForStopArgv` (:295) / `buildShowLastMessageArgv` (:311) +
`resolvePairAgentwrapPath` (:632) → keeper agent; `cli/pair.ts` `runAgentwrap`
(:138) + call site (:367). Convert the daemon boot probe `checkAgentwrapPresence`
(`daemon.ts:1421`) into a SELF-check (resolve the keeper launcher path / bun
present) — KEEP the `want("autopilot")` gate + warns-not-exits. Route
`resolveAgentwrapPath` call sites (db.ts:302, daemon.ts:3275, dispatch.ts:394)
onto `resolveKeeperAgentPath`. CRITICAL: preserve `mapAgentwrapExit` (:1061)
`{INTERNAL:1, BAD_ARGS:2, NOOP:3, RETRYABLE:4}` byte-for-byte (it feeds
`dispatch_never_bound` / TTL sweep / completion-reap); ensure `keeper agent`'s
exit codes ESCAPE `cli/keeper.ts`'s dispatcher conventions intact (the agent
flow short-circuits the generic "unknown sub → exit 1"). Update the
`test/exec-backend.test.ts` byte-pin DELIBERATELY (the path token changes; the
exit map does NOT).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:952 buildAgentwrapLaunchArgv, :1061 mapAgentwrapExit (+ block comment :1041), :1137 agentwrapLaunch, :909 AGENTWRAP_TMUX_EXIT, :1001 parseAgentwrapStdout, :895 AGENTWRAP_SCHEMA_VERSION
- src/autopilot-worker.ts:1848 (agentwrapLaunch call), cli/dispatch.ts:394-405
- src/pair-command.ts:192/295/311/632, cli/pair.ts:138/367
- src/daemon.ts:1421 checkAgentwrapPresence (PATH-in-env caveat :1434), :3275 resolveAgentwrapPath, :3281 probe call
- src/db.ts:302 resolveAgentwrapPath; test/exec-backend.test.ts (byte-pin home, 111 refs)

**Optional** (reference as needed):
- cli/keeper.ts dispatcher exit conventions (the exit-code passthrough)

### Risks

- HIGHEST: worker launch is load-bearing — this rewrites the path autopilot + dispatch use to launch EVERY worker; a regression wedges all plan execution. Land with autopilot PAUSED (boot default); soak armed-off before unpausing.
- `mapAgentwrapExit` contract drift mis-classifies fails as sticky / transient → corrupts the never-bound breaker. Over-test the table; keep the byte-pin.
- Mid-cutover both binaries work (external agentwrap still linked), so a partial repoint is non-fatal — but verify no consumer is left half-pointed.

### Test notes

`bun run test:full` (touches daemon + dispatch + db) MANDATORY. Table-driven
test asserting every `(exitCode, parse) → outcome` survives. Live smoke:
`keeper dispatch work::<task>` lands a real worker via the in-binary path; an
autopilot dispatch lands one job armed-off. Use the injectable `spawn` / probe
seams to keep unit tests synthetic.

## Acceptance

- [ ] all launch consumers (exec-backend seam, autopilot-worker, dispatch, pair, daemon boot probe) spawn `keeper agent`; none spawn the external `agentwrap`
- [ ] `mapAgentwrapExit` {0,1,2,3,4} preserved byte-for-byte; `keeper agent` exit codes reach the caller un-clobbered by the dispatcher; byte-pin updated deliberately
- [ ] daemon boot probe is a self-check, `want("autopilot")`-gated, warns-not-exits
- [ ] `bun run test:full` green; live `keeper dispatch` smoke lands a real worker; autopilot soak armed-off clean
- [ ] `resolveAgentwrapPath` call sites routed onto `resolveKeeperAgentPath`

## Done summary

## Evidence
