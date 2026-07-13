## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/rpc-handlers.ts, src/server-worker.ts, src/collections.ts, src/protocol.ts, CLAUDE.md, test/db.test.ts, test/reducer-projections.test.ts, test/rpc-handlers.test.ts

### Approach

Copy the request_handoff durable-intent template exactly, per ADR 0054 and the adopted
awaits design doc: an `awaits` deterministic-replayed table (CREATE + one SCHEMA_STEPS
entry — version assigned at merge time per ADR 0020, SCHEMA_FINGERPRINT re-pinned — and
added to EVERY rewind DELETE block, seven sites) holding the intent id, condition spec,
follow-up doc path (spilled like the handoff doc_path — inline blobs overflow the UDS
frame), status state machine (waiting/firing/done/failed/timed_out/cancelled),
claimed_at lease (event-ts-derived; covers only the firing phase — waiting rows are
unclaimed and may wait forever by design), attempt counters. ONE new mutating RPC
`request_await` — the EIGHTH — whose payload carries an op variant (request | cancel);
wire-validation at the trust boundary REJECTS session-local condition kinds (only
server-evaluable predicates admitted), the bridge mints the synthetic event, and the fold
is null-safe (malformed payload → safe no-op, cursor advances). Register an
AWAITS_DESCRIPTOR so awaits are listable/watchable. Update CLAUDE.md's seven→eight RPC
enumeration in this same change.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/rpc-handlers.ts:594-725,832 — request_handoff (validation, doc_path spill, registration) — the template
- src/daemon.ts:8088-8210 + src/server-worker.ts:1620-1679,3955 — the synthetic mint + bridge plumbing
- src/reducer.ts:5446-5532 — HandoffRequested extract/fold null-safety pattern
- src/db.ts:5786-5820 — CREATE handoffs; rewind DELETE sites :1612/2637/2900/2969/3289/3905/4047; SCHEMA_STEPS tail :4219-4313
- src/collections.ts:834,959-976 — HANDOFFS_DESCRIPTOR + registry
- ~/docs/keeper-durable-awaits.md — the adopted design (its status/RPC line refs are stale; the shape is authoritative)

### Risks

- A missed rewind DELETE site strands rows and diverges re-folds — treat the seven sites as a checklist.
- The condition-kind allowlist at the trust boundary is the contract task 5's worker relies on — reject loud, name the supported subset.

### Test notes

Fold determinism (from-scratch re-fold byte-identical), malformed-payload no-op, cancel
variant folds waiting→cancelled, RPC rejects unknown/session-local kinds and unknown keys,
fingerprint re-pin green, descriptor lists rows.

## Acceptance

- [ ] request_await (with its cancel variant) round-trips through one synthetic event into the awaits projection, which re-folds deterministically and resets on every rewind path
- [ ] Session-local condition kinds are rejected loud at the trust boundary with the supported subset named
- [ ] Awaits are listable via the collection registry; the schema fingerprint is re-pinned
- [ ] CLAUDE.md enumerates eight RPC surfaces including request_await in this same change

## Done summary

## Evidence
