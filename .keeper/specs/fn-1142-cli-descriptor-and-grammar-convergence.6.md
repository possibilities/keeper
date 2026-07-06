## Description

**Size:** M
**Files:** cli/duration.ts (new), cli/status.ts, cli/await.ts, cli/baseline.ts, cli/board.ts, cli/jobs.ts, cli/usage.ts, cli/builds.ts, cli/git.ts, cli/autopilot.ts, src/agent/pair-subcommands.ts, src/agent/dispatch.ts, src/agent/main.ts, test/agent-run-capture.test.ts, test/pair-panel.test.ts, test/agent-pair-subcommands.test.ts, test/agent-panel-cli.test.ts, test/agent-hermes.test.ts, test/agent-launch-handle.test.ts

### Approach

One duration grammar, unit required. Promote a single shared parser (Go ParseDuration subset: ms/s/m/h, compounds like 1h30m) to `cli/duration.ts`; a bare number is exit 2 with a hint naming the expected shape ("duration needs a unit — e.g. 5s"). Fold in: the duplicated parseDurationMs in status and await; the six snapshot viewers' bare-seconds `--timeout <s>`; baseline's `--timeout-ms`/`--poll-interval-ms` renamed to `--timeout`/`--poll-interval` taking durations; `--stop-timeout-ms` renamed to `--stop-timeout` across the agent surface (run/wait/wait-for-stop and the main.ts skip-list). Hard cutover: the -ms spellings are gone, bare seconds are gone. Update the affected descriptor entries (flag names + value grammar). Help text states the grammar once per flag. Baseline's exit-code semantics are untouched (exit 1 = no terminal result stays; only its flag names/grammar change).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/status.ts:427 and cli/await.ts:336 — the two parseDurationMs duplicates to unify
- cli/baseline.ts:186-204 — the -ms flag parsing to replace
- src/agent/pair-subcommands.ts:104,120,167 + src/agent/main.ts:1067 — the --stop-timeout-ms definition sites and skip-list
- cli/board.ts:38 — representative viewer bare-seconds --timeout

**Optional** (reference as needed):
- src/agent/dispatch.ts — help text naming --stop-timeout-ms

### Risks

- Muscle-memory break on `--timeout 2` at the viewers — the exit-2 hint must name the fix (`2s`) so it is self-healing.
- `.keeper/specs` prose may cite `--stop-timeout-ms`; prior-epic specs are historical records — do not edit them.

### Test notes

Table-driven parser suite (valid/invalid/compound/bare-number-hint); per-surface flag rename coverage rides the existing agent suites (update invocations, add a retired-spelling-fails case each).

## Acceptance

- [ ] One shared parser owns duration parsing; every duration-valued flag accepts ms/s/m/h(+compounds) and rejects unitless values at exit 2 with a hint
- [ ] `--stop-timeout`, `baseline --timeout`, `baseline --poll-interval`, and the viewers' `--timeout` all take the shared grammar; the retired -ms and bare-seconds spellings hard-fail
- [ ] Descriptors and help text state the grammar for every duration flag

## Done summary
Shared unit-required duration grammar (cli/duration.ts): ms/s/m/h + compounds, bare numbers rejected with a self-healing hint. Folded in status/await parseDurationMs, the six viewers' bare-seconds --timeout, and renamed baseline --timeout-ms/--poll-interval-ms + agent --stop-timeout-ms to unit-required --timeout/--poll-interval/--stop-timeout (hard cutover). Descriptors + help state the grammar per flag. Note: status/await route the duration rejection to exit 2 via a threaded exitCode (their other usage faults keep the legacy exit 1).
## Evidence
