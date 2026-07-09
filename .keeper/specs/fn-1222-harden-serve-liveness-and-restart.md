## Overview

keeperd's serve path wedges under normal autopilot load and its watchdog both misses the
degraded shape (trivial probes pass while first-paint starves) and self-inflicts false deaths
(the probe leaks its own connections until the daemon cap-rejects its own probes and restarts).
The restart ledger undercounts overlapping-boot storms and cannot tell a CI bounce from a crash
loop, and nothing stops a second daemon from opening and migrating the DB. This epic fixes the
probe lifecycle, adds served-latency self-reporting with starvation triggers, root-causes and
bounds the serve saturation, gates the boot on a kernel flock, and rewrites the ledger as
append-only NDJSON with runtime-qualified crash-loop counting. Decisions are recorded in
docs/adr/0030-single-instance-gate-and-restart-provenance.md; vocabulary in CONTEXT.md
("Daemon liveness and restart forensics").

## Quick commands

- `bun test test/daemon.test.ts -t "decideServeLivenessWatchdog"` — pure-trigger matrix green
- `bun scripts/repro-serve-wedge.ts --clients 20 --rate-hz 50` — serve-wedge repro harness (extended with subscribe-churn + register-stampede by the saturation task)
- `lsof -a -p $(launchctl list | awk '/arthack.keeperd$/{print $1}') -U | grep -c keeperd.sock` — daemon-held socket-end census (self-probe orphans read distinctly post-fix)
- `cat ~/.local/state/keeper/restart-ledger.json` — NDJSON boot/enrichment lines with provenance after the ledger task lands

## Acceptance

- [ ] The watchdog probe cannot leak connections on any settle path, and a cap-rejection or error frame carrying the probe's correlation id counts as proof-of-life, never as death
- [ ] The serve worker self-reports served latency to main, and sustained first-paint starvation escalates through a named trigger while a healthy-but-loaded or suspend/resumed daemon never false-trips
- [ ] The ghost-subscription/fan-out mechanism is characterized in the repro harness and bounded in the server worker
- [ ] A second concurrent daemon exits before touching the DB, and a bounce of a healthy daemon never advances the crash-loop count while repeated early deaths still mint the distress row
- [ ] All new decision logic lives in pure seams covered by the fast suite; no test boots a real daemon

## Early proof point

Task that proves the approach: ordinal 1 (probe correctness). If the probe-lifecycle fix does not
eliminate the self-inflicted accept-stall false deaths in the repro harness, re-examine the
orphan-accumulation attribution before building the self-report stack on top.

## References

- docs/adr/0030-single-instance-gate-and-restart-provenance.md — the committed decisions
- docs/adr/0003-fatal-exit-over-self-heal.md — fatalExit-over-self-heal stance (unchanged); its ledger mechanism section is superseded by 0030 once the ledger task lands
- scripts/repro-serve-wedge.ts — fn-1082's red-capable serve-wedge harness, the saturation task's base
- src/usage-flock.ts — the bun:ffi flock primitive the single-instance gate reuses (macOS-arm64 hazards documented in its module doc)
- src/dead-letter.ts serializeEventLogRecord/parseEventLogLine — the NDJSON single-writer + torn-tail discipline the ledger mirrors
- Incident evidence: three wedge signatures (degraded starvation, true read-death, lockstep internal-probe failure) observed live; the probe-orphan → per-pid-cap → id-less-reject → false-death chain reproduced end-to-end by an external watcher accumulating exactly 16 connections
- Buildbot bounces keeperd via launchctl on green builds (reduction owned elsewhere); runtime-qualified counting makes them page-silent by design

## Docs gaps

- **CLAUDE.md**: revise the serve-liveness watchdog clause (new triggers, probe fix) — folded into the self-report task
- **CLAUDE.md**: revise the restart-ledger clause (NDJSON, provenance, runtime-qualified counting) and add ONE terse single-instance-gate guardrail line — folded into the flock and ledger tasks; keep `bun scripts/lint-claude-md.ts` green
- **docs/adr/0003-fatal-exit-over-self-heal.md**: supersession pointer for the ledger mechanism — folded into the ledger task

## Best practices

- **flock is per open-file-description:** dup/fork share one lock and close() on the last fd releases it — hold the fd in module scope on main, FD_CLOEXEC set, and never let a worker or subprocess touch it [Apple flock(2)]
- **Never stat the dylib before dlopen:** /usr/lib/libSystem.B.dylib lives in the dyld shared cache, not on disk — an existence pre-check fail-closes on every machine [Apple dyld]
- **Self-report over work-doing probes:** a liveness check that does real work false-fails merely because the process is slow; keep the probe trivial and judge starvation from self-reported served latency [k8s liveness literature]
- **Judge report staleness by the receiver's clock:** a starved worker's own timestamps are late by construction; main stamps arrival on its monotonic clock [Inngest worker-threads postmortem]
- **NDJSON durability is single-writer + one write per line + tolerant tail:** PIPE_BUF atomicity does not apply to regular files; compact at boot via temp-file + fsync + rename [POSIX]
