## Description

**Size:** M
**Files:** cli/ (new reclaim verb + registration), src/backup.ts (export/adapt reclaimDb if needed), README.md, test/backup.test.ts

### Approach

Add a `keeper reclaim` subcommand that invokes the existing `reclaimDb` (src/backup.ts:
VACUUM INTO a temp in the destination dir -> verify the copy -> atomic same-fs rename over
the live DB). It is an OFFLINE op: hard-guard against running while the daemon holds the DB
(check the UDS socket is dead / the keeperd pid is gone — the daemon's open connection would
break on the swap, and a concurrent writer corrupts the copy). Keep a pre-reclaim snapshot;
self-verify the reclaimed DB (opens clean, schema_version unchanged, auto_vacuum=2 preserved,
key projection row counts match) BEFORE declaring success; fail loud and leave the original
intact on any mismatch. Document the operator runbook (pause autopilot -> bootout daemon ->
keeper reclaim -> bootstrap -> await server-up -> verify re-fold byte-identical). Mirror the
existing cli verb registration + --agent-help conventions.

### Investigation targets

**Required** (read before coding):
- src/backup.ts — reclaimDb / VACUUM INTO / atomic-swap + snapshot helpers (resolveBackupDir, snapshotName, the verify-after-VACUUM-INTO step)
- cli/ — how existing keeper subcommands register + their --agent-help strings
- the daemon UDS socket path + pid/liveness check (how `keeper await server-up` / the autopilot client detect the daemon) to build the "daemon is down" guard
**Optional**:
- test/backup.test.ts — the slow-tier backup test shape to extend

### Risks

- The atomic swap MUST run with the daemon stopped — a live daemon connection + the rename = corruption. The guard is load-bearing.
- VACUUM INTO on a ~1.2 GB DB holds a long read txn — ensure the offline assumption (no concurrent writer).
- Self-verify must run BEFORE the pre-reclaim snapshot is removed, so a bad reclaim is recoverable.

### Test notes

- reclaim shrinks the file, preserves schema_version + auto_vacuum=2, key projection row counts identical; guard refuses when the daemon is up.
- `bun run test:full` (backup.test.ts is slow-tier).

## Acceptance

- [ ] `keeper reclaim` runs reclaimDb offline with a daemon-up guard + pre-reclaim snapshot + self-verify (schema/auto_vacuum/row-counts) before success; runbook documented; test:full green

## Done summary

## Evidence
