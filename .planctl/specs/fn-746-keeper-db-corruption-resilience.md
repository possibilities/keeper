## Overview

On 2026-06-07 (~02:07) keeperd logged `SQLiteError: database disk image is
malformed` followed by a `panic: Segmentation fault` — a single incident, and
the DB is verified intact now (`PRAGMA integrity_check → ok`, 603k events). But
a corruption error + native segfault on a now-**~2 GB** `keeper.db` is a latent
reliability risk we should get ahead of: today it self-recovered via a launchd
restart, but a persistent corruption would take down the whole event log +
projections (keeper's source of truth), and right now nothing PROACTIVELY
detects corruption — it only surfaced because a query happened to hit it.

Three goals: (1) DETECT — a low-overhead periodic integrity probe that pages on
failure, so future corruption is caught immediately, not silently; (2) DIAGNOSE
+ MITIGATE the likely contributors — WAL checkpoint cadence on a 2 GB DB (a
large unchecked WAL degrades reads and widens torn-read windows), whether the
cold-blob compaction is keeping pace with growth, and the bun:sqlite
concurrent-access pattern that segfaulted under load; (3) RECOVER — a
backup/snapshot + documented restore path so a future malformed image isn't
catastrophic.

SCOPE BOUNDARY (coordination): keep the integrity probe OFF `cli/keeper-watch.ts`
— fn-745 is actively editing it. Prefer the standalone `cli/keeper-watchdog.ts`
(already a dependency-free dead-man monitor) or a low-frequency daemon-side
timer + the backstop/notify path. This epic should be UNPARKED only after fn-745
lands if `.1` ends up touching keeper-watch. INVARIANTS: probes are read-only /
producer-side (never in a fold); re-fold determinism, the cursor+projection
single-transaction, and the sole-writer rules are untouched.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "PRAGMA quick_check;"`
- `sqlite3 ~/.local/state/keeper/keeper.db "PRAGMA wal_checkpoint(PASSIVE);"`
- `du -h ~/.local/state/keeper/keeper.db*`
- `bun test test/keeper-watchdog.test.ts`  # if monitoring lands there

## Acceptance

- [ ] A low-overhead periodic integrity probe (`PRAGMA quick_check` on a
  read-only connection) runs on a sane cadence and PAGES on failure — corruption
  is detected proactively, not by chance. It does NOT hold a long lock or starve
  the writer on the ~2 GB DB.
- [ ] The malformed+segfault contributors are diagnosed and the safe mitigations
  applied: WAL checkpoint cadence, compaction-keeps-pace check, and the
  concurrent-access pattern that segfaulted (a guard or serialization if found).
- [ ] A backup/snapshot + documented restore path exists so a future malformed
  image is recoverable, not catastrophic.
- [ ] No change to fold/cursor/re-fold-determinism/sole-writer invariants; probe
  is read-only/producer-side; monitoring stays OFF keeper-watch.ts (fn-745).

## Early proof point

Task `.1` (diagnose + detection) is the get-ahead-of-it core: even if the root
cause of the one-off segfault stays unproven, proactive detection + a recovery
path convert a silent catastrophe into a caught, recoverable event. `.2`
(mitigation + recovery) builds on `.1`'s findings.

## References

- Incident: `~/docs/keeper-incident-2026-06-08-continuity.md` + the daemon
  stderr `malformed`/`Segmentation fault` lines (2026-06-07 ~02:07).
- `cli/keeper-watchdog.ts` (standalone dead-man — candidate monitoring home),
  `src/compaction.ts` (cold-blob relocation — the size-management lever),
  `src/daemon.ts` periodic-timer pattern (pending-dispatch sweep / compaction).
- fn-745 (in flight, edits keeper-watch.ts — DO NOT overlap).

## Best practices

- **`PRAGMA quick_check` over full `integrity_check`** for a periodic probe — far
  cheaper on a 2 GB DB, still catches structural corruption. Run on a read-only
  conn, low frequency. [practice-scout]
- **`wal_checkpoint(PASSIVE)` on cadence** — a large WAL degrades reads and
  widens the window for torn reads under concurrency. [practice-scout]
- **Only producers probe; never integrity-check inside a fold** (re-fold
  determinism). [keeper CLAUDE.md]
- **PID/connection concurrency: a segfault in bun:sqlite under concurrent
  readers+writer points at a shared-handle or torn-page read** — verify each
  worker has its OWN connection (worker contract) and main is the sole writer.
