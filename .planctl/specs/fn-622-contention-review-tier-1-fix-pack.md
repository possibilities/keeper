## Overview

Tier 1 of the keeper contention review (see `docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` and the follow-up response). Four independent items to ship first: gate the server-worker's `srvTs` diagnostic logging behind `KEEPER_TRACE_SERVER=1`, add staged timing instrumentation to `runQuery` / `diffTick` / `writeFrames` under the same gate, add per-collection slow-flight logging + hard-deadline reconnect to the readiness client, and split the hook's `openDb` call from the daemon's `migrate()` path. Together these stop the avoidable contention (hook running migrations per event, server-worker logging 437 MB to stderr), make the remaining stalls measurable, and make the readiness client recover from missed query responses without a manual restart.

## Quick commands

- `bun test` — full test suite green
- `KEEPER_TRACE_SERVER=1 launchctl kickstart -k gui/$UID/arthack.keeperd` — restart the daemon with tracing
- `tail -f ~/.local/state/keeper/server.stderr | grep '^\[srv-ts\]'` — watch stage timings
- Without `KEEPER_TRACE_SERVER` set: `server.stderr` should grow only via rare `[server-worker]` error lines

## Acceptance

- [ ] `KEEPER_TRACE_SERVER=1` gates ALL `[srv-ts]` output via call-site `if (TRACE)` wrappers; the rare `[server-worker]` error class stays un-gated
- [ ] `runQuery` / `diffTick` / `writeFrames` emit structured `key=value` lines under the same gate, compatible with downstream p50/p95/p99 aggregation
- [ ] Readiness client emits `query_slow_flight` once at 1 s and `query_timeout` + reconnect at 5 s per stuck collection, via the existing `connectWithRetry` machinery
- [ ] Hook `openDb` passes `migrate: false`; daemon remains the sole migrator
- [ ] Sidecar `arthack.keeperd.logrotate.plist` LaunchAgent truncates `server.stderr` + `launchctl kickstart`s the daemon on a weekly schedule
- [ ] README and CLAUDE.md reflect the new env var, the daemon-must-boot-first invariant, the one-time `server.stderr` truncate step, and the rotation sidecar install

## Early proof point

Task that proves the approach: `<epic>.1` (gate `srvTs` + module-level `TRACE` + rotation sidecar). Once that lands, `tail -f ~/.local/state/keeper/server.stderr` with `KEEPER_TRACE_SERVER` unset should produce zero new `[srv-ts]` lines under normal load — the immediate, observable confirmation that the largest known log-volume contributor is contained. If somehow the gate misses a call site, the failure is loud and local: grep for `srvTs(` and audit. If the failure is silent (somehow the env var is set in the running daemon), that's a deploy-environment bug, fixed by unsetting + restarting.

## References

- `/Users/mike/docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` — original Carmack-style audit identifying the contention sources
- `/Users/mike/docs/2026-05-27-keeper-review-followup-response.md` — reviewer's revised priority plan that orders these four items first
- `/Users/mike/docs/2026-05-27-keeper-review-questions-for-reviewer.md` — clarifying questions and design tradeoffs surfaced during re-verification

## Docs gaps

- **README.md**: add `KEEPER_TRACE_SERVER` to the env-var section near the existing `KEEPER_SOCK` mention; add an install/upgrade note (one-time `truncate -s 0 ~/.local/state/keeper/server.stderr` before re-bootstrapping; daemon must boot at least once before the hook can write events; install the `arthack.keeperd.logrotate.plist` sidecar)
- **CLAUDE.md**: update "Migrations are forward-only" to add "the daemon is the SOLE migrator; the hook calls `openDb(..., { migrate: false })` and never runs schema convergence"
- **plist/arthack.keeperd.plist**: document `KEEPER_TRACE_SERVER` as a recognized env var under `EnvironmentVariables` (operator-discoverable; default unset)
- **plist/arthack.keeperd.logrotate.plist**: new sidecar LaunchAgent (created in task `<epic>.1`) — the weekly truncate + kickstart job; documented in the README install section

## Best practices

- **Gate at the call site, not inside `srvTs`.** The function body interpolates `Date.now()` before any gate would fire, and the caller's template-literal `msg` arg allocates regardless. Wrapping with `if (TRACE) srvTs(...)` is the only shape that gives true zero-overhead-when-off.
- **Read `process.env.KEEPER_TRACE_SERVER` exactly once at module load** into a module-level `const TRACE = process.env.KEEPER_TRACE_SERVER === "1";`. V8/JSC elides the branch; per-call env reads do not.
- **Use `performance.now()` for sub-ms stage marks**, `Date.now()` only for the wall-clock prefix. Conditionally allocate: `const t0 = TRACE ? performance.now() : 0;` so a `TRACE=0` daemon does zero stage work.
- **Per-tick log gating: only emit when any stage > 5 ms OR total > 10 ms.** A 50 ms poll at rest would otherwise produce ~1200 `diffTick` lines/minute with `TRACE=1`, drowning the signal.
- **`query_slow_flight` fires once per stuck window**, not every poll while in-flight — `lastSlowFlightAt` per state, cleared in `teardownConnection`. Single-flight `reconnecting` guard so concurrently-stuck collections produce one reconnect, not many.
- **macOS log rotation is `newsyslog`, not `logrotate`** — but newsyslog requires either daemon SIGHUP-reopen (we don't have it) or daemon termination on every rotation (bad). The chosen path is a sidecar user-LaunchAgent that truncates the log + `launchctl kickstart`s the daemon on schedule. No sudo, no fd-reopen plumbing, weekly restart cost is acceptable.
