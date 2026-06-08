## Overview

The fn-746 backup timer is a plain `setInterval` that resets on every daemon
boot. A keeperd that restarts more often than every 24h — the exact scenario
the LaunchAgent recovery path produces after a corruption crash — will silently
never complete an automatic backup. This epic adds a boot-time overdue check:
if the newest snapshot is older than `BACKUP_INTERVAL_MS` (or none exists),
a one-shot catch-up backup fires shortly after startup before the regular
interval begins.

## Acceptance

- [ ] On boot with no prior snapshot, a catch-up backup fires within the startup delay.
- [ ] On boot with a snapshot older than `BACKUP_INTERVAL_MS`, a catch-up backup fires within the startup delay.
- [ ] On boot with a fresh snapshot, no catch-up fires and the regular 24h timer is unchanged.
- [ ] The catch-up path shares the same never-throw, log-on-failure, page-on-failure contract as the regular timer callback.
- [ ] Tests cover all three boot-state cases.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F3 | kept | .1 | Confirmed at `src/daemon.ts:3596–3630`: plain `setInterval` with no boot-time overdue check; in the crash-restart scenario the automatic backup floor is silently never reached. |
| F1 | culled | — | Documented design tradeoff; comments own it; not a correctness issue. |
| F2 | culled | — | Fine as-is; inline comment explains the SQL-literal quoting; no injection vector. |
| F4 | culled | — | Thin glue over already-tested pure function; low risk. |
| F5 | culled | — | Untestable side effect by design; deliberately wrapped in try/catch. |

## Out of scope

- Making the backup interval configurable.
- Changing the VACUUM INTO mechanism or 24h cadence.
- Daemon-restart frequency detection or backoff.
