## Description

**Size:** M
**Files:** src/await-worker.ts, src/daemon.ts, cli/await.ts, cli/status.ts, test/await-worker.test.ts, test/status.test.ts

### Approach

The leased await-worker copies handoff-worker verbatim in shape: isMainThread guard, own
read-only openDb (prepareStmts:false), typed {kind}/{type} messages, data_version
watchLoop, atomic conditional claim (waiting + condition-met → firing with claimed_at
lease; lease expiry reclaims), the never-bound-style breaker, and a pure decision table
driving waiting→firing→done/failed/timed_out. Condition predicates are the existing pure
await-conditions functions evaluated over the worker's DB snapshot (verify each supported
kind is constructible from it); the follow-up launches as a FRESH session via the same
launch transport (the arming session is expected dead); firing is at-least-once intent
with an idempotent follow-up (stable intent id). cli/await.ts gains --durable (fires
request_await and returns; in-process form unchanged) and a list surface. cli/status.ts
gains the display-only needs_human.finalize_pending count (done ∧ worktreeMode ∧ ¬landed
∧ paused; requires opting the status subscription into the landed-epic set) with
STATUS_SCHEMA_VERSION bumped 9→10 and the status golden updated — never counted into
total/jammed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/handoff-worker.ts:1-165 — the full template: lease TTL, ack timeout, breaker, decideHandoffAction (:130-165)
- src/await-conditions.ts — pure predicates (landedState ~:1202); src/readiness-client.ts computeLandedEpicIds + includeRecentDoneEpics
- cli/await.ts:961-1016 — SlotState (unchanged in-process path); cli/status.ts:76 STATUS_SCHEMA_VERSION=9, :198-223,382-427 needs_human assembly, :567 the bare subscription to widen
- src/daemon.ts — worker spawn/supervision sites (mirror how handoff-worker is spawned; supervisor owns lifecycle)

### Risks

- The lease must cover only firing — a waiting row is never claimed, so a long wait cannot lease-expire.
- finalize_pending must never enter total/jammed (mirror finalize_non_ff handling); the status golden breaks on the new field (required update).

### Test notes

Pure worker tests over synthetic rows + injected now: claim/lease/reclaim, breaker,
at-most-once fire under redelivery (idempotent effect), timeout transition, unknown-kind
terminal-fail without spin; status envelope test: finalize_pending present, display-only,
version 10.

## Acceptance

- [ ] A durable await fires its follow-up as a fresh session at most once effect-wise, survives daemon restarts, times out when configured, and never lease-expires while waiting
- [ ] `keeper await --durable` persists and returns; the in-process await is unchanged; durable awaits are listable
- [ ] needs_human.finalize_pending reports a paused done-but-unlanded epic, is never jam-counted, and ships with the version bump + golden update

## Done summary
Added the leased durable-await worker (src/await-worker.ts) mirroring handoff-worker's shape, wired daemon supervision + synthetic lifecycle events, added cli/await.ts --durable and list surfaces, and the display-only needs_human.finalize_pending status field with STATUS_SCHEMA_VERSION bumped to 10.
## Evidence
