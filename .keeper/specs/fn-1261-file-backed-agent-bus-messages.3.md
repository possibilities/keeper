## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-db.ts, test/bus-worker.test.ts, test/bus-db.test.ts

### Approach

Make the bus worker and its independent bus.db schema persist the complete typed reference needed for live delivery and queued replay while retaining existing inline rows. New reference rows store no message body; their forensic size is the declared artifact byte length. The worker rejects new inline chat publishes, validates references before persistence/fanout, and reconstructs the original typed payload on queued-for-wake replay instead of downgrading it to `text/plain`.

Couple artifact cleanup to the existing bounded sole-writer retention pass. Queued rows protect their artifacts regardless of age. Live and wake-delivered rows record a terminal delivery timestamp and remain readable for seven days from that point. Row pruning returns the exact artifact ids eligible for best-effort removal after the database transaction; failed deletes remain safe orphans for a separately bounded cursor/page pass. Crash-window files with no row age through an orphan grace period, while an inconclusive database check retains rather than deletes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:165 — current payload and delivered-envelope types.
- src/bus-worker.ts:1134 — queued-for-wake replay currently rebuilding `text/plain` from `row.body`.
- src/bus-worker.ts:1183 — publish persistence and fanout lifecycle.
- src/bus-worker.ts:1527 — paced fail-soft retention pass.
- src/bus-db.ts:89 — independent forward-only `PRAGMA user_version` migration.
- src/bus-db.ts:337 — body persistence and `body_size` derivation.
- src/bus-db.ts:390 — recipient-keyed queued replay.
- src/bus-db.ts:420 — bounded age pruning with queued preservation.

**Optional** (reference as needed):
- test/bus-db.test.ts:45 — bus schema migration and downgrade-refusal tests.
- test/bus-db.test.ts:286 — queued isolation, dedup, and retention fixtures.
- test/bus-worker.test.ts:707 — queued payload and offline classification fixtures.

### Risks

The bus database has its own migration ladder and must not touch keeper's schema version. Cleanup ordering must never delete a file while a queued or retained row can still deliver it; row-first deletion makes artifact-delete failure an orphan rather than making DB failure a dangling live reference. The retention pass must preserve its bounded per-tick cost and fail-soft behavior.

### Test notes

Cover fresh and upgraded bus.db schemas, downgrade refusal, new-reference and legacy-inline rows, byte-size semantics, live and wake replay payload identity, queued age immunity, delivery-based grace, row-first cleanup, delete failure, orphan discovery, ambiguous database reads, and bounded work per retention tick.

### Detailed phases

1. Add the provisional bus.db migration fields needed for typed reference persistence and terminal-delivery timing.
2. Persist and replay reference payloads without changing legacy inline rows.
3. Enforce reference-only new chat publishes and preserve honest outcome/status transitions.
4. Extend bounded retention with row-coupled artifact deletion and bounded orphan collection.

### Alternatives

Serializing references into the legacy body column avoids a migration but overloads body semantics, loses a typed replay contract, and complicates safe cleanup. Independent age-based artifact pruning was rejected because queued rows are age-immune.

### Non-functional targets

Each retention tick touches only the existing bounded row batch plus one bounded orphan page. Runtime handling remains fail-soft and never throws through the worker; migration failure remains isolated and loud at bus-worker boot.

### Rollout

The migration is forward-only and preserves old inline rows. Reference consumers remain dual-format until legacy queued rows drain; producer enforcement activates only once the worker can persist and replay typed references.

## Acceptance

- [ ] The independent bus.db migration preserves existing rows, stores new typed references without message bodies, and refuses downgrade from a newer schema.
- [ ] Live and queued replay deliver byte-equivalent structured reference payloads, while existing inline queued rows still replay as inline text.
- [ ] New inline chat publishes are rejected without crashing the worker; control namespaces and legacy stored rows remain unaffected.
- [ ] `queued_for_wake` artifacts are never age-pruned, and terminally delivered artifacts remain readable for seven days from delivery rather than original send time.
- [ ] Row pruning and artifact deletion are bounded, row-driven, retry-safe, and fail-soft; crash-window orphans are collected without an unbounded directory scan or deletion on inconclusive state.
- [ ] Fast tests cover schema, replay, retention, cleanup ordering, and failure paths without starting a real worker or socket.

## Done summary
Bus worker and bus.db now persist and replay typed artifact references end-to-end: a provisional migration adds reference/delivery-timestamp columns, live and queued-for-wake replay reconstruct the original structured payload (legacy inline rows still replay as text), new inline chat publishes are rejected while control namespaces are unaffected, and the bounded retention pass couples row-first artifact deletion to a 7-day post-delivery grace with age-immune queued rows and bounded orphan collection.
## Evidence
