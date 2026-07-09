## Description

**Size:** M
**Files:** src/server-worker.ts, src/daemon.ts, test/daemon.test.ts, CLAUDE.md

### Approach

Give the watchdog eyes on what real clients experience. The server worker times every dispatch
unconditionally (promote the timing out of the KEEPER_TRACE_SERVER gate — the ~20ns
performance.now() pair, not the logging) and every 10–15s posts `{kind:"serve-health"}` over
parentPort carrying dispatch p99, busy-ms, sample count, and a worker-side
monitorEventLoopDelay p99 — durations only, never timestamps; main stamps arrival on its own
monotonic clock. `decideServeLivenessWatchdog` stays pure and gains two named triggers:
`serve-report-mute` (arrival-clock staleness — a frozen serve loop stops reporting) and
`serve-starvation` (N consecutive breach windows AND queueing AND saturated AND ourFault via
process.cpuUsage delta AND sample count above a floor — a quiet window is inconclusive, not
breaching). Convert accept-stall from wall-clock age to consecutive-failed-attempt counting,
and add ONE global clock-jump guard: a detected discontinuity (>3× interval since last tick)
resets every trigger's state — probe attempts, arrival baseline, breach windows — so laptop
suspend/resume cannot false-trip any trigger, old or new. fatalExit reason strings NAME the
trigger per the existing carve-out discipline. Update CLAUDE.md's watchdog clause in place.
The worker releases its histogram and interval in its own shutdown handler and never posts
after stopping.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:3542 — decideServeLivenessWatchdog inputs/verdict union to extend; the ~10 SWD_BASE cases at test/daemon.test.ts:1082 reshape with it
- src/server-worker.ts:1320 — the TRACE-gated _t0.._t3 dispatch timing to promote (TRACE flag ≈454)
- src/daemon.ts:11763 — the watchdog producer interval: lag histogram, probe stamps, verdict call, fatalExit reason formatting (≈11851)
- src/daemon.ts:6288 — the sw.onmessage bridge gaining the serve-health branch

**Optional** (reference as needed):
- scripts/repro-serve-wedge.ts — its lag detector mirrors the busy-wedge leg; keep the harness's decide copy in sync

### Risks

- process.cpuUsage is process-wide in Bun (threadCpuUsage is undefined): ourFault reads "the daemon is burning CPU", not "the serve worker is" — the conjunction bounds the false-positive cost; state the granularity honestly in the trigger docs
- Threshold calibration: baseline dispatch p99 under healthy load before pinning breach thresholds; eventLoopUtilization is a Bun stub returning zeros — never use it

### Test notes

Extend the SWD_BASE matrix: mute staleness, starvation conjunction (each term individually
insufficient), sample-count floor, consecutive-attempt accept-stall, clock-jump reset clearing
all trigger state. Keep every case synthetic-clock pure.

## Acceptance

- [ ] The serve worker reports served-latency health periodically with durations only, and main judges staleness by its own arrival clock
- [ ] Sustained first-paint starvation escalates through a named serve-starvation trigger only when queueing, saturation, own-CPU, and sample-count conditions all hold across consecutive windows
- [ ] A muted serve worker escalates through serve-report-mute after the staleness bound
- [ ] A simulated clock discontinuity resets all trigger state and no trigger fires across it
- [ ] Dispatch timing runs unconditionally with trace logging still gated, and the worker cleans up its histogram and interval on shutdown
- [ ] CLAUDE.md's watchdog clause describes the new trigger set; the CLAUDE.md lint stays green

## Done summary
Serve worker self-reports served latency (durations only) every ~12s; decideServeLivenessWatchdog is now a pure reducer with attempt-counted accept-stall plus serve-report-mute and serve-starvation triggers and a clock-jump guard that resets all trigger state. Dispatch timing runs unconditionally; the worker releases its histogram + interval on shutdown.
## Evidence
