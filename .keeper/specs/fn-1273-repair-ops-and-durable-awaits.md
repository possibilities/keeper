## Overview

Five ops-reliability gaps from the 2026-07-12/13 drain, resolved per ADR 0054 (extends
0049/0053): repairs always end terminal (silent-stop pages within one grace), repair stickies
carry an actionable diagnosis, dead-writer shared-checkout dirt self-heals through the spool,
the daemon restarts via one CLI verb, and awaits become durable server-side intents that
survive their arming session.

## Quick commands

- `bun test test/daemon.test.ts test/status.test.ts test/rpc-handlers.test.ts` — repair sweep/status/RPC surfaces green
- `keeper daemon restart` — kickstarts and waits until the daemon answers healthy
- `keeper await --durable landed <epic>` — persists an await that survives this session

## Acceptance

- [ ] A repair session stopped without a recorded terminal outcome pages once after the grace and re-arms only via the retry wire; the sticky/brief carries a bounded failing-tests digest plus the baseline leaf key
- [ ] Shared-checkout dirt whose cwd-matched writer sessions are all provably terminal past the grace is backed up to the spool and cleaned (never ignored files, never mid-merge), letting the dirty row level-clear; any ambiguity pages once
- [ ] `keeper daemon restart` kickstarts the LaunchAgent and exits zero only when the daemon answers healthy and caught up, distinguishing a throttled respawn from a slow boot
- [ ] A durable await outlives its arming session, fires its follow-up exactly once as a fresh session, rejects session-local conditions loud, and is listable; the status envelope gains the display-only finalize-pending count
- [ ] The RPC allowlist documentation moves seven→eight in the same change that adds the awaits RPC

## Early proof point

Task that proves the approach: ordinal 4 (awaits projection + RPC) — it exercises the full
handoff-template copy (schema step, fold, RPC, descriptor); if the template doesn't transfer
cleanly, re-scope the awaits half to a refined design doc and land ordinals 1-3 alone.

## References

- docs/adr/0054-terminal-repairs-dead-writer-sweep-durable-awaits.md (the decision record)
- ~/docs/keeper-durable-awaits.md (the adopted awaits design; note its STATUS_SCHEMA_VERSION and RPC line refs are stale — live status version is 9)
- docs/adr/0049 + 0053 (repair retry + dirt spool being extended)
- CONTEXT.md: Repair session, Needs-human, Dead-writer sweep, Durable await, Lane dirt spool (all current)

## Docs gaps

- **CLAUDE.md**: "Writes are tightly scoped" seven→eight with request_await enumerated, and the Autopilot repair prose revised in place — owned by ordinal 4 and ordinal 1 respectively; lint-claude-md stays green
- **docs/problem-codes.md**: new daemon-restart family (kickstart-failed, health-timeout, throttled-respawn) owned by ordinal 3; shared_checkout_jam entry edited for the sweep self-heal by ordinal 2

## Best practices

- **At-least-once intent + idempotent follow-up:** exactly-once delivery is unachievable; dedup at the effect [AWS/Sequin]
- **Atomic conditional claim:** UPDATE...WHERE status-or-expired RETURNING; lease > worker hard-timeout
- **Dead-man's-switch grace:** declined only after expected-duration + grace; liveness evidence over wall-clock alone
- **(pid, start_time) attribution, never bare PID:** PID reuse (CWE-367)
- **Readiness over process-up:** poll socket-answers AND caught-up, N consecutive successes, jittered backoff; surface launchd throttle distinctly
