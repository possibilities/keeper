## Description

**Size:** M
**Files:** src/rpc-handlers.ts, src/reducer.ts, src/collections.ts, src/db.ts, src/server-worker.ts, test/handoff.test.ts

### Approach

Extend the existing `request_handoff` RPC payload (no new RPC — the write surface stays closed) with the capture fields: a `capture` boolean (defaults false), optional launch-triple fields (model/effort or preset reference), and a request-time-computed, slug-deterministic envelope path recorded as a `handoffs` projection column so waiters and the worker discover one authoritative location. Follow the `target_dir` additive template end-to-end: CLI-side validation happens in a later task, RPC re-validates at the socket trust boundary defaulting absent→null/false, the payload extractor stays strict-on-load-bearing / coerce-rest-to-null / never-throws, and the fold UPSERTs with ON CONFLICT refreshing only request-time columns. A pre-feature `HandoffRequested` event must fold to defaults (capture off, null triple/path) — re-fold determinism is sacred, so no wall-clock/env/filesystem reads inside the fold. Append one SCHEMA_STEPS entry for the new columns, derive SCHEMA_VERSION from the ladder tail, and re-pin SCHEMA_FINGERPRINT (PROVISIONAL until landed; never hardcode "the next" version in prose). Thread the new params through the worker→main request_handoff bridge.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/rpc-handlers.ts:604-696 — RequestHandoffParams + validateRequestHandoffParams; the trust-boundary validation this extends
- src/reducer.ts:6102-6210 — HandoffRequestedPayload, extractor, foldHandoffRequested; the target_dir nullable pattern to copy
- src/collections.ts:883-912 and src/db.ts:5875 — HANDOFFS_DESCRIPTOR.columns + DDL that must gain the columns
- src/db.ts:69 — SCHEMA_STEPS ladder shape and the addColumnIfMissing convention
- src/server-worker.ts:321-333,1636-1700 — the worker→main bridge the params thread through

**Optional** (reference as needed):
- src/handoff-slug.ts — slug normalization the envelope path derives from
- test/handoff.test.ts — existing request/fold test shapes to extend

### Risks

- A throwing extractor or a fold reading the environment breaks re-fold determinism — copy the target_dir discipline exactly.
- Schema-ladder position is a singleton resource; the version renumbers at fan-in, so keep the step additive-idempotent.

### Test notes

Pure fold tests over freshMemDb()/migrate(): a pre-feature event (no capture fields) folds to defaults; a capture event folds all fields; malformed capture data coerces to null without throwing. No daemon, no socket.

## Acceptance

- [ ] A capture-bearing handoff request round-trips: RPC validation accepts it, the event folds, and the handoffs projection exposes capture flag, triple, and envelope path
- [ ] A pre-feature handoff event (no new fields) folds to defaults with no error and no behavior change
- [ ] Malformed capture payload data folds safely (coerced/nulled), never throws, and the cursor advances
- [ ] The schema ladder gains exactly one new entry and the fingerprint is re-pinned; a fresh DB and a migrated DB agree on the handoffs shape

## Done summary
Threaded handoff capture fields through persistence (schema step 130 + fingerprint re-pin, collections/reducer/rpc/server surfaces); operator re-run 640/0 across db/handoff/rpc-handlers/daemon suites; landed via plain-git escape (leg 5a361ee6 claim wedge) as 187b8c5c on the epic lane
## Evidence
- Commits: 187b8c5c
- Tests: bun test db+handoff+rpc-handlers+daemon 640/0 (operator re-run in lane)