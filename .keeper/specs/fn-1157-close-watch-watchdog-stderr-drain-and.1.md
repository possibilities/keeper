## Description

Finish the watch-watchdog hardening left residual by the source epic. Three
audit findings, one file-pair (`scripts/watch-watchdog.ts` +
`test/watch-watchdog.test.ts`), landing as one commit:

- F1 (scripts/watch-watchdog.ts:197, evidence: `stderr: "pipe"` at line 197
  with the Promise.all at 216-219 draining only stdout, proc.stderr never
  consumed). A child that writes more than the OS pipe buffer (~64KB) to
  stderr blocks on the write while the parent drains stdout and awaits
  `proc.exited`, wedging until the 5s PROBE_TIMEOUT_MS kill fires a false
  anomaly — the exact backpressure class this epic set out to eliminate,
  moved to the sibling pipe. Fix: set `stderr: "ignore"` (nothing reads it)
  or add `new Response(proc.stderr).text()` to the Promise.all so both
  pipes drain concurrently.
- F3 (scripts/watch-watchdog.ts:256-284, evidence: test file drives only
  runWatchdogLoop via injected runCheck; checkMonitors has zero coverage).
  The unverifiable-own-job branch (own job row absent OR monitors snapshot
  null -> hold green, never false-page) is the epic's headline fix and is
  untested. Add a pure seam (e.g. factor the own-job classification over a
  `Job[]` into a pure helper, or make checkMonitors' jobs fetch injectable)
  and test both the unverifiable degrade and the dead-sibling path.
- F4 (test/watch-watchdog.test.ts:109, evidence: the "--no-bus filter" test
  hardcodes `checks: ["monitors","status"]` and never calls parseArgv with
  --no-bus nor exercises main's `CHECK_NAMES.filter((c) => c !== "bus")`).
  Add a parseArgv-level assertion that --no-bus yields `bus: false` and the
  derived checks array excludes "bus".

All three share the same two files and land as one PR touching only the
watch-watchdog script and its test.

## Acceptance

- [ ] No watch-watchdog probe subprocess can stall on an un-drained pipe.
- [ ] checkMonitors' unverifiable-own-job branch (and the dead-sibling path) has pure-tier coverage.
- [ ] parseArgv/main --no-bus wiring is asserted directly, not via a pre-filtered array.
- [ ] `bun test` stays green (fast pure tier; no real subprocess booted).

## Done summary
Drained stderr concurrently in keeperJson (F1), factored classifyMonitors as a pure seam with direct unverifiable/dead-sibling coverage (F3), and fixed + directly tested the --no-bus flag-to-filter wiring via deriveChecks (F4).
## Evidence
