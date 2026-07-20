## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts, test/birth-ingest-worker.test.ts

### Approach

A birth record is a session mint, not a mutation receipt — it can never
name a mutation path, so it has no business on the commit rail's
fail-closed gate. Today gcStuckBirthRecord parks VALID fully-parseable
birth records (grant stuck wait/deny past grace, pid dead) under the
globally-blocking poison status, discarding the real session/cwd the
record carries (parkPoisonBirth stores session_id='poison'). Contract:
a birth record that parses under the current parser is parked under a
distinct NON-blocking terminal status that preserves its provenance
(real session_id, cwd, pid) and doubles as the earlier grant-starvation
signal — minted at grant-decision time for terminal-negative 'deny',
after the existing grace for transient 'wait'. Only genuinely
unparseable birth-tree bytes still mint poison. The new status matches
the existing producer shape (deterministic dl_id, ON CONFLICT DO
NOTHING, bounded post-COMMIT backstop) and the retention prune gains an
arm for it so rows age out. dead_letters.status is TEXT — a new value
needs no migration; if any bookkeeping column is added it is one
SCHEMA_STEPS entry with the fingerprint re-pinned.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:6950-7107 — gcStuckBirthRecord + its three call sites (the wait/deny arms at :7076-7088 are where the earlier signal mints)
- src/daemon.ts:6888-6936 — parkPoisonBirth (the provenance-discarding park this replaces for classifiable records)
- src/daemon.ts:5831 — pruneRecoveredDeadLetters (gains the new status arm)
- src/birth-record.ts — parseBirthRecord (the classifiability test) and PROVIDER_LEG_GRANT_TIMEOUT_MS context

**Optional** (reference as needed):
- test/birth-ingest-worker.test.ts:539-576 — the producer isolation test shape
- ~/docs/keeper-phase2-backlog.md #75 — the sibling grant-timeout finding; do not widen into it, but keep the seam compatible with a launcher-side birth retirement

### Risks

- The commit-work gate must never see the new status as blocking (that integration lands in the gate task, which depends on this one for the vocabulary — coordinate the status name via the shared constant, not a string literal)
- Fold-safety unaffected (dead_letters is an operational sidecar main writes directly), but preserve the deterministic dl_id shape so re-parks stay idempotent

### Test notes

Seed a parseable stuck birth + dead pid through the existing GC test
seams; assert the new status, preserved provenance fields, prune aging,
and that a genuinely unparseable birth still mints poison.

## Acceptance

- [ ] A fully-parseable stuck birth record parks under the non-blocking status with its real session, cwd, and pid preserved
- [ ] A terminal-negative grant arms the signal at decision time; a transient wait arms it only past the existing grace
- [ ] Genuinely unparseable birth-tree bytes still park as poison
- [ ] The retention prune ages out the new status; re-parking the same record is idempotent

## Done summary
Parseable stuck birth records (grant denied immediately, or wait past the existing grace, or a perpetually-throwing mint) now park under a new non-blocking birth-stuck dead-letters status with real session_id/cwd/pid preserved, exported as BIRTH_STUCK_STATUS for the later commit-work-gate task; only genuinely unparseable birth-tree bytes still mint poison, and the retention prune ages out birth-stuck rows.
## Evidence
