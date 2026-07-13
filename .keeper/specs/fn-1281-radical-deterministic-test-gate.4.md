## Description

**Size:** M
**Files:** test/helpers/template-db.ts, test/autopilot-worker.test.ts, test/events-ingest-worker.test.ts, test/dead-letter-worker.test.ts, test/plan-worker.test.ts, test/birth-ingest-worker.test.ts, test/session-state.test.ts, test/db.test.ts, test/git-boot-seed.test.ts

### Approach

Convert current-schema consumers to `freshMemDb()` or `freshDbFile()` according to connection semantics, so the v0→head ladder runs only when migration is the subject. Shrink scale fixtures to boundary-sized correctness cases: replace the 300-row intake load, repeated 5,070-row planner seeds, and 4,000-event wall-clock copy proof with tiny exactly-once, N−1/N/N+1, and migration-floor examples. Consolidate current-schema shape/index assertions over template clones while retaining the accepted compact migration/Re-fold matrix.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/helpers/template-db.ts:1-18,63-73,103-153 — template image, memory clone, and WAL-safe file clone
- test/events-ingest-worker.test.ts:814-863 — 25-file/300-row repeated scan
- test/db.test.ts:435-487 — essential ladder/fingerprint proofs
- test/db.test.ts:3203-3324 — planner fixtures and 5,000 noise rows
- test/git-boot-seed.test.ts:761-825 — 4,000-event wall-clock migration proof
- test/refold-equivalence.test.ts:2052-2100 — byte-identical deterministic projection proof

**Optional** (reference as needed):
- CLAUDE.md:94-101 — template and sandbox rules
- docs/adr/0020-schema-version-renumber-at-merge-time.md — ladder singleton behavior

### Risks

In-memory clones cannot prove WAL, reopen, locking, or atomic replacement. Template timestamps are intentionally frozen and cannot support per-test freshness assertions. Shrinking planner populations may change SQLite plan selection; semantic correctness and planner-performance diagnostics must be separated explicitly.

### Test notes

Maintain ladder/fingerprint, zero→head, latest transition, representative destructive/backfill, downgrade refusal, reopen/idempotence, Re-fold equivalence, and keep-set safety. Use tiny fixtures; no functional test asserts elapsed milliseconds.

### Detailed phases

1. Inventory every direct `openDb` in listed non-migration suites.
2. Convert single-connection consumers to memory clones and reopen/WAL consumers to file clones.
3. Split current-schema assertions from migration assertions.
4. Replace production-sized rows/files with boundary-sized examples.
5. Mutation-check the preserved migration matrix before deleting redundant cases.

### Alternatives

Sharing one mutable DB across tests was rejected because isolation failures are harder to diagnose. Exhaustive old-version migration cases were rejected in favor of representative state-shape transitions.

### Non-functional targets

No listed current-schema consumer performs a full migration per test; fixture setup is deterministic and private under file-level parallelism.

### Rollout

Convert one suite at a time and compare retained invariant coverage before deleting old fixtures; never change production migration behavior in this task.

## Acceptance

- [ ] Listed non-migration suites use template clones and perform no per-test full migration.
- [ ] The 300-row, 5,070-row repeated, 15,210-total, and 4,000-event functional fixtures are absent from the fast gate.
- [ ] The compact migration and Re-fold integrity matrix remains green and mutation-sensitive.
- [ ] WAL/reopen semantics use isolated file clones; single-connection semantics use memory clones.
- [ ] No functional assertion depends on hardware elapsed time or production-scale noise.

## Done summary

## Evidence
