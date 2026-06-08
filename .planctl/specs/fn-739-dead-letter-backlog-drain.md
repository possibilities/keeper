## Overview

Live read-only check (2026-06-08) found a large dead-letter backlog under
`~/.local/state/keeper/dead-letters/`: ~4839 non-empty per-pid NDJSON files,
~4929 dead-lettered events, ~50M, mtimes spanning 2026-05-29 → 2026-06-07
(still accruing, not a one-time spike). Each dead letter is a hook event that
FAILED to land in `events` and fell to the per-pid NDJSON safety net (correct
fail-open — the hook still exits 0 — but the row is absent from projections
until replayed). 4929 is well above a hygiene threshold and runs against the
zero-dead-letter reliability goal.

Strong hypothesis: these are `SQLITE_BUSY` failures from the hook's own
`BEGIN IMMEDIATE` INSERT under WAL writer contention (the 60→343ms cliff
documented in the fn-736 baseline). **fn-736 removes the hook's SQLite INSERT
entirely** (the hook now appends NDJSON; the daemon ingester does the writes),
so this dead-letter CLASS should stop accruing once fn-736's hook flip is
deployed. This epic (a) recovers the already-stranded 4929 events safely, and
(b) confirms/denies the cause so we know whether fn-736 fully closes it.

Maintenance-only: prefer report + sanctioned drain over core behavior change.
No change to the hook fail-open contract; replay goes through the sanctioned
MAIN-only `replay_dead_letter` path (keeper CLAUDE.md sole-writer rule), never
a direct DB write.

## Quick commands

- `ls ~/.local/state/keeper/dead-letters/ | wc -l`  # backlog count
- `du -sh ~/.local/state/keeper/dead-letters`        # backlog size
- `cat ~/.local/state/keeper/deadletter-drain.log`   # existing drain log
- re-fold determinism check after drain: replayed rows must fold byte-identically

## Acceptance

- [ ] The ~4929-event backlog is drained with ZERO row loss via the sanctioned
  `replay_dead_letter` path; replay is idempotent (re-running yields no
  duplicate `events` rows).
- [ ] Drained per-pid files are removed (or archived) only after their rows are
  confirmed landed; a post-drain count baseline is recorded.
- [ ] A one-line finding states the dominant failure cause (confirm/deny the
  `SQLITE_BUSY`/WAL-contention hypothesis) → whether fn-736 closes the class
  or a separate follow-up is needed.
- [ ] No change to the hook fail-open contract; no direct DB write (replay
  through MAIN only).

## References

- Synthesis: `~/docs/keeper-followups-synthesis-2026-06-08.md` (dead-letter
  "hygiene" row — escalated here); proposal:
  `~/docs/keeper-followups-epic-plan-proposal-2026-06-08.md` P3.
- Existing drain tooling: `~/.local/state/keeper/deadletter-drain.{sh,ts}` +
  `deadletter-drain.log`.
- `src/dead-letter.ts` (`serializeDeadLetterRecord` / `parseDeadLetterLine` —
  null on partial/garbage), `src/dead-letter-worker.ts`, the
  `replay_dead_letter` RPC + `dead_letters` sidecar path in `src/daemon.ts`.
- Sequencing: drain the backlog now; defer the "stays at zero" re-measure
  until after fn-736's hook flip is deployed.

## Best practices

- Idempotent replay only — never line-count; verify rows landed before deleting
  files. A torn final line must not be replayed (parser returns null).
- Replay is MAIN-only (`replay_dead_letter`); the babysitter/CLI never writes
  the DB or emits synthetic events directly.
