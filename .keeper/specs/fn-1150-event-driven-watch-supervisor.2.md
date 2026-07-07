## Description

**Size:** M
**Files:** src/readiness-client.ts, cli/status.ts, cli/await.ts, test/readiness-client.test.ts, test/status.test.ts

### Approach

Implement ADR 0011 (docs/adr/0011-gated-dispatch-failures-snapshot-fold.md — read it first; the decision is settled). `SubscribeOptions.includeDispatchFailures` gates a new `makeState("dispatch_failures", ...)` created only when the flag is set, else null, subscribing unbounded (limit: 0 — the no-row-cap sentinel; the collection self-prunes and exact counts are load-bearing for the wall threshold). Both the states-array push and the first-paint gate are guarded on non-null, mirroring the includeRecentDoneEpics recipe exactly: with the flag off, the subscribe-collection set and first-paint byte-shape are unchanged for every existing consumer. The snapshot member `dispatchFailures` is spread-when-present (absent when un-opted, like landedEpicIds) and the gate holds first paint until the opt-in collection paints, so a painted snapshot always carries real rows — a transient fold failure can never read as "no jam". Then flip both consumers: `cli/status.ts` passes the flag, feeds `snap.dispatchFailures` to buildStatusEnvelope, and deletes its out-of-band queryCollection (one round-trip instead of two); `cli/await.ts` deletes its bespoke subscribeCollection + handle + paint slot, driving the opt-in from `drained --fail-on-stuck` for now (task 4 generalizes the derivation to the full condition-set union). Keep the row field names (verb/id/reason) intact through the fold so the projector math is source-agnostic.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:1671-1717 — the includeRecentDoneEpics gated-fold recipe (makeState-when-flag, null-guarded states push); :196-208 — the ADDITIVE-fold warning naming the invariant; :1748-1752 — the first-paint gate guard shape to mirror; :1758-1900 — snapshot assembly and spread-when-present members
- cli/await.ts:2157-2170 — the bespoke dispatch_failures subscribe to delete (its comment already calls it a stopgap); :943 — the openDispatchFailures gate
- cli/status.ts:525-538 — the call site flipping to snap.dispatchFailures; :597-598 — the out-of-band fetch to delete
- test/readiness-client.test.ts:374 — the subscribe-count byte-identity test shape (OFF stays at the current collection count, new name absent); :394-468 — the gate-holds-until-opt-in-paints test shape

**Optional** (reference as needed):
- cli/control-rpc.ts:182-209 — the old out-of-band read also used limit: 0, so the fold is row-set-identical (no truncation change to re-litigate)

### Risks

- Forgetting the !== null push guard silently changes first-paint gate arity for every non-opt-in consumer — the exact failure the gated pattern exists to prevent; the subscribe-count test is the tripwire.
- buildStatusEnvelope's third arg is currently a raw Row[]; the folded rows must satisfy the same field access with no renames.

### Test notes

Mock-socket subscribe tests (makeMockConnect / takeOutbound / deliver pattern): flag-off count unchanged and member absent; flag-on adds exactly the one collection, gate holds until it paints, member carries the rows. Status envelope parity test before/after the source flip. Existing drained --fail-on-stuck await tests must pass unchanged against the snapshot-sourced rows.

## Acceptance

- [ ] With the flag off, the readiness subscribe opens the same collection set as before and the snapshot carries no dispatch-failures member
- [ ] With the flag on, the snapshot carries the full unbounded dispatch-failures row set and first paint gates on that collection painting
- [ ] keeper status reads dispatch failures from the snapshot in one round-trip with a byte-identical envelope; the out-of-band query is gone
- [ ] keeper await drained --fail-on-stuck behaves identically sourced from the snapshot; the bespoke collection stream is deleted
- [ ] Subscribe-count and gate-hold tests cover both flag states

## Done summary

## Evidence
