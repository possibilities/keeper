## Description

**Size:** M
**Files:** src/backup.ts, cli/reclaim.ts, src/maintenance-worker.ts, test/backup.test.ts, test/reclaim.test.ts, test/maintenance-worker.test.ts, test/integrity-probe.test.ts

### Approach

Separate backup/reclaim orchestration from physical SQLite/filesystem execution. Unit-test naming, retention, due decisions, refusal, classification, swap/sidecar plans, cleanup idempotence, and relay outcomes through injected storage operations. Preserve only tiny file-backed SQLite checks that uniquely prove verified-restorable output, corruption rejection, persistence/reopen, or atomic replacement; remove repeated VACUUM/VACUUM INTO/bloat/corruption journeys and duplicated full-path sidecar assertions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/backup.test.ts:1-18,57-72 — current layered storage contract
- test/reclaim.test.ts:132-221 — repeated production-faithful physical journeys
- src/backup.ts:80-84 — dominant full-DB I/O boundary
- test/maintenance-worker.test.ts:4-8,49-145 — relay tests whose heavy bodies already have separate coverage
- test/integrity-probe.test.ts:1-28 — pure verdict plus narrow real SQLite precedent

**Optional** (reference as needed):
- SQLite WAL and in-memory documentation — when a file-backed proof is mandatory

### Risks

Over-faking storage can miss SQLite transaction, corruption, persistence, and rename behavior. Keep one tiny proof per irreducible semantic, not one end-to-end journey per caller. Cleanup targets must remain canonical and confined.

### Test notes

Use injected executable/args and storage operations; no shell. Keep fixtures synthetic and tiny. Assert cleanup failure and partial retry as explicit state, not background eventual behavior.

### Detailed phases

1. Extract pure backup/reclaim plans and typed executor results.
2. Convert maintenance relays to injected operations.
3. Replace bloat-based assertions with tiny purpose-built database/file fixtures.
4. Delete duplicate full physical journeys.
5. Verify remaining file-backed tests stay sub-second and isolated.

### Alternatives

Moving current tests to a storage slow tier was rejected because no slow correctness tier remains.

### Non-functional targets

No fast storage test creates production-proportion payloads or runs a physical journey more than once; retained file-backed checks use per-test roots and bounded output.

### Rollout

Preserve the old tests until each unique invariant has a named replacement, then delete them in the same task.

## Acceptance

- [ ] Backup/reclaim/maintenance decisions are covered through injected seams without repeated physical journeys.
- [ ] Only tiny file-backed checks remain for verified restore, corruption, persistence/reopen, and atomic-file semantics that memory tests cannot prove.
- [ ] Repeated VACUUM, VACUUM INTO, 500×4KB/300×2KB bloat, and duplicate full swap/sidecar runs are absent from fast tests.
- [ ] Cleanup confinement, idempotence, partial failure, and refusal remain independently verifiable.
- [ ] No storage correctness test requires a scoped timeout above the package default.

## Done summary
Extracted injectable backup/reclaim plans and typed executor operations, converted maintenance-worker relays to injected seams, and replaced repeated VACUUM/bloat physical journeys with deterministic unit tests; retained only tiny file-backed SQLite checks for restore, corruption, persistence/reopen, and atomic-swap semantics.
## Evidence
