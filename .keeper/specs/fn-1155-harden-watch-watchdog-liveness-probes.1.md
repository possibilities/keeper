## Description

Harden the two probe-robustness gaps in `scripts/watch-watchdog.ts` and add
the missing pure-unit coverage. All three findings trace to this one file and
land as one commit.

- F1 (`scripts/watch-watchdog.ts:210`, evidence: read at :208-231): `keeperJson`
  awaits `proc.exited` before draining `proc.stdout`. A child whose output
  exceeds the OS pipe buffer (~16-64KB on macOS) blocks on write while the
  parent blocks on exit — a backpressure deadlock. `keeper query jobs` on a
  busy autopilot board can exceed the buffer. Fix: read stdout concurrently
  with the exit await (e.g. `Promise.all([new Response(proc.stdout).text(),
  proc.exited])`) or attach the reader before awaiting exit; keep the
  `PROBE_TIMEOUT_MS` kill and error envelopes intact.
- F2 (`scripts/watch-watchdog.ts:266`, evidence: read at :240-277): `checkMonitors`
  treats any non-`waiting` `monitorRunningState` verdict as "sibling gone", but
  that function returns `{kind:"met"}` for NON-dead unverifiable cases too — the
  own job row not yet in the `jobs` projection, and `ownJob.monitors === null`
  (snapshot-replaced each Stop, empty until the arming turn's Stop hook writes
  it). Distinguish "verifiably no matching entry" from "cannot verify yet" and
  hold green on the latter, mirroring the existing `ownSessionId === null`
  degrade at line 249.
- F3 (whole file, evidence: no `test/*watchdog*` exists): add a `runWatchdogLoop`
  pure-unit test driving its `runCheck` / `sleep` deps (factored out for exactly
  this) through a miss -> miss -> recover -> miss sequence, asserting exactly one
  anomaly per episode — exercising the two-miss debounce, the `reported[name]`
  single-fire-until-recovery latch, the recovery reset, and the `--no-bus` filter.

Files: `scripts/watch-watchdog.ts`, plus a new `test/watch-watchdog.test.ts`
(pure-in-process, no real subprocess / wall-clock / socket — honor the repo test
isolation rules).

## Acceptance

- [ ] `keeperJson` drains stdout concurrently with the exit await — no deadlock
      on >pipe-buffer child output.
- [ ] `checkMonitors` holds green when the own job row is absent or its monitors
      blob is null (unverifiable), and only flags a verifiably-absent matching
      monitor.
- [ ] `test/watch-watchdog.test.ts` drives `runWatchdogLoop` through
      miss -> miss -> recover -> miss and asserts exactly one anomaly per episode.
- [ ] `bun test` stays green.

## Done summary

## Evidence
