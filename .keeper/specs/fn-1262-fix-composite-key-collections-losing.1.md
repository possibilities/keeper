## Description

**Size:** M
**Files:** src/collections.ts, test/collections.test.ts

### Approach

Generalize the existing `liveKeyColumns` composite live-identity mechanism (today declared only on `dispatch_failures`) to the three REGISTRY descriptors whose SQLite primary key is composite but whose descriptor `pk` names a single column, so the diff layer stops collapsing sibling rows into one watched slot and silently dropping existing-row version transitions. The identity helpers (`liveKeyExpr`/`liveKeyOf`) and all five diff-path consumers (version probe, full-row fanout, membership token, watched-set seed, diff byId) already route through them, so this is a descriptor-only change plus one served-column addition:

- `subagent_invocations`: add `agent_id` to `columns` AND declare `liveKeyColumns: ["job_id","agent_id","turn_seq"]`.
- `scheduled_tasks`: declare `liveKeyColumns: ["job_id","cron_id"]` (`cron_id` already served).
- `pending_dispatches`: declare `liveKeyColumns: ["verb","id"]` (`id` already served) — mirror the `dispatch_failures` exemplar exactly.

Update the SERVER-side "byId collapses" rationale in the descriptor doc comments, but PRESERVE the client-facing "read `state.rows`, not `byId`" guidance — the client `byId` still keys on the single wire `pk` and still collapses, so that guidance stays true and load-bearing. Do NOT change wire/filter/page-detail `pk`. This is the live serve path, outside the re-fold charter: no `SCHEMA_VERSION`/`SCHEMA_FINGERPRINT` bump (the columns already exist; `liveKeyColumns` is a TypeScript descriptor constant).

Add a schema-derived registry contract test: walk `REGISTRY`, read each table's SQLite primary-key columns via `PRAGMA table_info`, and fail when a composite-PK collection's declared live-identity key does not set-match its PK columns — so the next composite-PK collection added must either declare its key or be an explicit, justified exemption.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/collections.ts:623 — `dispatch_failures` descriptor: the exact `pk` + `liveKeyColumns` exemplar to mirror.
- src/collections.ts:1020 — `liveKeyExpr` / `liveKeyOf` / `LIVE_KEY_DELIM`: the identity helpers; reuse, never hand-roll.
- src/collections.ts:497, :537, :726 — the three descriptors to fix (subagent_invocations, scheduled_tasks, pending_dispatches) and their existing `columns`/doc comments.
- src/collections.ts:943 — `REGISTRY`: the walk root for the contract test (composite tables outside REGISTRY like `dispatch_never_bound` are correctly skipped).
- test/collections.test.ts:1580 — `seedDispatchFailure` helper + the exemplar test cluster at :1601 (liveKeyExpr composes / liveKeyOf distinct / `selectVersionsByIds` map.size===2 / countAndToken) to clone for the three descriptors.
- src/db.ts:5053, :5083, :5454 — schema: confirm `agent_id` / `turn_seq` / `cron_id` / `id` are NOT NULL before adding any to a live key.

**Optional**:
- src/collections.ts:1192 — `countAndToken` membership-token doc + impl (already keys by `liveKeyExpr`).
- src/readiness-client.ts:1234 — `mergePatchRow` (single-pk keyed) — confirms why the client "read state.rows" guidance stays.

### Risks

- A live-key column that is NULL or absent from `columns` collapses every row to a NULL/"undefined" key, re-introducing the bug. All four identity columns are NOT NULL and only `agent_id` needs adding to `columns` — verify both before relying.
- The contract test must NOT false-positive on `block_escalations` (composite PK `(epic_id, task_id)` but wire `pk` `task_id` is globally unique, so it correctly needs no `liveKeyColumns`). Carry an explicit per-collection classification / exemption rather than a bare "composite PK ⟹ liveKeyColumns required" rule; compare PK columns as sets.

### Test notes

Clone the exemplar cluster at test/collections.test.ts:1601 for all three descriptors (add sibling `seedSubagentInvocation` / `seedScheduledTask` / `seedPendingDispatch` helpers). Assert `map.size === 2` for two same-parent rows — the regression guard for the collapse bug. The contract test needs a migrated DB for `PRAGMA` introspection: use `freshMemDb()` + `migrate()` to stay in the fast `bun test` tier (no subprocess/socket/Worker).

## Acceptance

- [ ] The three composite-PK collections each declare a live-identity key covering their full SQLite primary key, and `agent_id` is served on `subagent_invocations`.
- [ ] Two rows sharing the descriptor's wire `pk` but differing in the rest of the composite key are tracked as two independent identities: a version transition on one is detected (the version probe returns both, not one), verified by cloned unit tests asserting two distinct tracked keys.
- [ ] A schema-derived registry contract test walks `REGISTRY` and fails if any composite-PK collection lacks a live-identity key set-matching its PK columns, with `block_escalations` classified as an intentional single-key exemption.
- [ ] The client-facing "read `state.rows`, not `byId`" guidance is preserved; only the server-side collapse rationale is updated.
- [ ] `bun test` (fast tier) is green and no schema version or fingerprint changes.

## Done summary
Generalized liveKeyColumns to subagent_invocations, scheduled_tasks, and pending_dispatches (served agent_id); added a schema-derived REGISTRY contract test walking PRAGMA table_info to enforce composite-PK live identity, with block_escalations as the explicit single-key exemption.
## Evidence
