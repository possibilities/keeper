## Description

**Size:** M
**Files:** cli/jobs.ts (new), cli/keeper.ts, test/jobs.test.ts (new), test/keeper-cli.test.ts

### Approach

Write `cli/jobs.ts` modeled on `cli/board.ts` + `cli/git.ts`: own
`HELP`, own `createLiveShell({ title: "jobs" })`, own sidecars under
`/tmp/keeper-jobs.<pid>.*` (pass `script: "jobs"` to
`buildDebugSnapshot` so copied paths match written files), own SIGINT
teardown calling `liveShell.dispose()` + `handle.dispose()`. It
subscribes via `subscribeReadiness({ idPrefix: "jobs", ... })` and
renders ONLY the jobs body — port `renderJobsBody` + `projectJobRow`
from board (ambient no-`plan_verb` partition over plan-bound
partition, inner `~~~` divider, empty-side drop rule, each row
trailed by `subagentLinesFor(..., "  ")` from `src/board-render.ts`).
It carries the dead-letter banner: `waitingDeadLetterCount` +
`persistentBannerPill()` re-stamped via `liveShell.setStatus()`
BEFORE the body byte-compare short-circuit, plus the `c` copy and `r`
replay keys (`r` → `sendReplayDeadLetterRpc` over a fresh connection,
single-flight guard, shared flash-restore timer). State JSON sidecar
carries `jobs` (+ subagentInvocations/deadLetters). Wire the
dispatcher: add `"jobs"` to `SUBCOMMANDS`, a `jobs:` handler
(`(argv) => (await import("./jobs")).main(argv)`), and a `USAGE`
line ("Live jobs list"). Add `test/jobs.test.ts` (job-row shape,
ambient/plan partition + empty-side drop, nested sub-agent lines,
dead-letter pill) using the mock-socket pattern from `test/git.test.ts`;
add the `jobs` handler + `isSubcommand("jobs")` assertion to
`test/keeper-cli.test.ts` (the `for (const sub of SUBCOMMANDS)` loop
auto-covers routing).

### Investigation targets

**Required** (read before coding):
- cli/board.ts:1286-1346 — projectJobRow + renderJobsBody (the bottom-list rendering to port)
- cli/board.ts:1360-1375,1456-1517 — renderBody / emitFrame ordering (banner re-stamp before byte-compare)
- cli/board.ts:1481-1646 — dead-letter banner + flashTimer + c/r handlers + SIGINT (the lifecycle to carry over)
- cli/board.ts:1648-1664 — subscribeReadiness call + SIGINT teardown shape
- cli/git.ts:281-443 — sibling single-purpose main skeleton (HELP, onKey forward-ref, sidecars, emitFrame, emitLifecycle, SIGINT)
- cli/keeper.ts:26-33,114-133 — SUBCOMMANDS / USAGE / handlers map
- src/clipboard-debug.ts:54-57 — buildDebugSnapshot re-derives sidecar paths from `script`
- test/git.test.ts:33-60 — mock-socket connect-factory pattern
- test/keeper-cli.test.ts:48-53,145-171 — handler map + isSubcommand block

**Optional** (reference as needed):
- src/board-render.ts — the primitives extracted in task 1
- cli/usage.ts:655-1010 — multi-handle main + teardown reference

### Risks

`subscribeReadiness` first-paint gate is all-five-strict — jobs.ts
waits on epics/git too even though it renders only jobs+subs+deadLetters;
the empty steady state of each collection still produces a `result`
so the gate clears. Don't narrow the gate (shared helper, board needs
all five). Keep the `r` RPC on a SEPARATE connection (subscribe socket
is read-only).

### Test notes

`bun test test/jobs.test.ts test/keeper-cli.test.ts` green. Manually
run `keeper jobs --help` and `keeper jobs` to confirm the frame +
banner + keys.

## Acceptance

- [ ] `cli/jobs.ts` renders the jobs body (partitions + nested sub-agent lines) with `/tmp/keeper-jobs.<pid>.*` sidecars and a "jobs" live-shell title
- [ ] The `[dead-letter:N]` banner re-stamps before the body byte-compare; `r` replays one dead-letter over a fresh connection; `c` copies the frame
- [ ] `keeper jobs` is routable: SUBCOMMANDS/USAGE/handler added; `test/keeper-cli.test.ts` asserts `isSubcommand("jobs")`
- [ ] `test/jobs.test.ts` covers job-row shape, partition + empty-side drop, nested sub-agent lines, dead-letter pill
- [ ] `bun test test/jobs.test.ts test/keeper-cli.test.ts` passes

## Done summary

## Evidence
