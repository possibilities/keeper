# 3. Fatal exit over in-process self-heal

## Status

Accepted.

## Context

Long-lived daemons accumulate in-process recovery code: catch an unexpected error,
try to reset the offending subsystem, respawn a dead worker inline, and keep
running. This hides faults — a daemon that silently patches over a broken
invariant drifts into a corrupt state that is far harder to diagnose than a clean
crash, and a worker respawned in-process can double-run or leak the resource that
killed it.

## Decision

keeper does not self-heal in process. Any unrecoverable error calls `fatalExit`,
which exits the process with a non-zero status. Recovery is a single external
path: a LaunchAgent restarts the daemon, gated on the non-zero exit, giving a
clean boot from durable state rather than a patched-up in-memory one. Workers are
never respawned in-process; the supervisor owns all lifecycle.

The narrow carve-outs are explicit and bounded — closing a stale client socket,
capped boot-seed retries before escalating to `fatalExit`, and liveness watchdogs
that themselves `fatalExit` a wedged path while naming what tripped. A sustained
crash-loop is made loud, not invisible: each boot is appended to a durable restart
ledger and a single sticky distress row is minted, level-cleared once the boot
rate recovers.

## Consequences

- Faults surface as crashes with a clean restart, so the running process is always
  a faithful fold of durable state, never a self-repaired approximation.
- Recovery logic lives in one place (the supervisor and the LaunchAgent contract),
  not scattered across every subsystem as bespoke retry code.
- A genuine crash-loop is observable through the restart ledger and distress row
  instead of being masked by silent retries.
- The cost is that transient, genuinely-recoverable blips also take a full restart;
  this is accepted because a clean boot is cheap and the alternative is
  undiagnosable drift.
