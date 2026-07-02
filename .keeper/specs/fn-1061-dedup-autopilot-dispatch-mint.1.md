## Description

**Size:** M
**Files:** src/daemon.ts, src/db.ts, keeper/api.py, test/agent-dispatch.test.ts (or a new test file per existing naming), test/schema-version.test.ts fixtures as needed

### Approach

Add a producer-owned operational table `dispatch_mint_gate(dispatch_key
TEXT PRIMARY KEY, minted_at REAL NOT NULL)` (key = the existing
`verb::id` dispatchKey format). In handleDispatchedMint, wrap the gate
check + event insert in one transaction on the daemon main writable
connection: read the gate row; if `now - minted_at < 60s` → suppress (no
insertEvent) and reply a DISTINCT suppressed ack (extend the
dispatched-ack payload, e.g. `{id, ok:false, suppressed:true}` — the
exact shape is this task's contract deliverable for .2); else UPSERT the
gate row and insertEvent as today, reply ok. EVERY path still replies —
a hung ack wedges the worker. Evict stale gate rows (minted_at older
than a few windows) riding sweepExpiredPendingDispatches. Clear the gate
row on the retry_dispatch producer path so the human fast-path is never
swallowed. New table ⇒ bump SCHEMA_VERSION 101→102, widen
SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the SAME commit, add the
forward-only migration; the gate table is NOT in EPHEMERAL_PROJECTIONS
and NOT in the rewind DELETE list (it is producer state, not a
projection, same class as dead_letters) and is excluded from
refold-equivalence comparison. Do NOT add any constraint to the events
table (historical dup rows exist).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:5141-5215 — handleDispatchedMint: the insert + ack paths the gate wraps; :5179-5199 the ack-promises-insert-not-fold comment (why the gate must be transactional at this site)
- src/daemon.ts:5553-5593 — the TTL sweep (eviction rides here; same-connection sequencing rationale)
- src/db.ts:49 SCHEMA_VERSION; :1130-1146 pending_dispatches + dispatch_never_bound DDL (naming/shape precedent); :1639 EPHEMERAL_PROJECTIONS; :3694-3716 migration + rewind patterns
- src/autopilot-worker.ts:3785-3796 — the retry_dispatch / failedKeys clear the gate-clear must sit beside
- keeper/api.py SUPPORTED_SCHEMA_VERSIONS — the same-commit whitelist rule (test/schema-version.test.ts gates it)

**Optional** (reference as needed):
- src/daemon.ts:1401 — the dead_letters idempotent-insert precedent (note: prefer explicit conflict handling over bare INSERT OR IGNORE — it swallows unrelated constraint failures)
- test/refold-equivalence.test.ts — confirm the gate table sits outside the compared set

### Risks

The ack contract: any early-return that skips the reply hangs the
worker's awaited ack forever. The transaction boundary: gate read +
insert must be atomic or a crash between them either un-dedups the next
attempt or suppresses a legit one forever.

### Test notes

Double-mint within the window → one events row + suppressed ack;
re-mint after the window → second row; restart between mints (fresh gate
read from DB) → still suppressed inside the window; retry_dispatch
clears the gate; eviction prunes stale rows; schema-version test green.

## Acceptance

- [ ] Same dispatchKey minted twice within 60s → exactly one events row; second gets a distinct suppressed ack; every path replies
- [ ] Gate survives a daemon restart within the window
- [ ] retry_dispatch clears the gate row; TTL/cooldown-cadence re-dispatches pass
- [ ] SCHEMA_VERSION + api.py whitelist bumped in the same commit; forward migration; refold-equivalence + schema-version tests green
- [ ] No events-table constraint; no change to fold logic

## Done summary
Added the durable dispatch_mint_gate table (v101->v102) that suppresses same-verb::id re-mints within a 60s window at the Dispatched mint site, wrapping the gate check + event insert in one transaction; re-mints reply a distinct ok:false,suppressed:true ack, retry_dispatch clears the gate, and stale rows age out on the pending-dispatch sweep.
## Evidence
