## Overview

The watch-watchdog hardening epic drained the probe subprocess's stdout
concurrently with its exit await, killing a backpressure false-page — but
left `stderr: "pipe"` un-consumed, re-seating the same deadlock class on the
sibling pipe. It also shipped its headline unverifiable-vs-dead fix in
`checkMonitors` and a `--no-bus` filter with no direct coverage. This
follow-up finishes that hardening: drain (or ignore) stderr so no probe can
wedge, and close the two coverage gaps on the epic's own deliverable.

## Acceptance

- [ ] No probe subprocess can stall on an un-drained pipe (stderr drained concurrently or set to ignore).
- [ ] `checkMonitors`' unverifiable-own-job branch has direct pure-tier coverage.
- [ ] The `--no-bus` flag-to-filter wiring (parseArgv + main) is exercised by a test, not just a pre-filtered array.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | watch-watchdog.ts:197 pipes stderr but the Promise.all at 216-219 drains only stdout; a >64KB-stderr keeper subcommand re-triggers the 5s backpressure false-page this epic targeted. |
| F2 | culled | —  | keeperJson drains a real subprocess; the fast-tier rule forbids subprocess I/O and there is no pure seam, so this constrained gap is not actionable. |
| F3 | kept   | .1 | checkMonitors (watch-watchdog.ts:256-284) has zero coverage and its unverifiable-own-job branch is the epic's headline fix. |
| F4 | kept   | .1 | the --no-bus filter test (watch-watchdog.test.ts:109) hardcodes a pre-filtered checks array; parseArgv/main filter wiring is never exercised. |

## Out of scope

- A direct subprocess-I/O regression test for the keeperJson stdout drain (F2) — the fast pure-tier forbids booting a real subprocess and no pure seam exists.
- Any change to the debounce/latch/recovery loop semantics, which are already covered.
