## Description

**Size:** S
**Files:** src/server-worker.ts, cli/status.ts, test/status.test.ts, test/slow/daemon-smoke.test.ts, docs/adr/0073-sandboxed-real-daemon-smoke-tier.md

### Approach

Live evidence: against a healthy caught-up daemon, `keeper status` reads `event_store: null` while `computeEventStoreStatus` always returns count and bytes — the block rides the boot-status header, which the serve worker stamps only on object-form frames and omits from memoized steady-state replies BY CONTRACT (the restart probe now depends on that omission as its caught-up signal). Move the event-store block off the ephemeral boot header onto a delivery path that exists at steady state — the status snapshot's own reply surface or an always-stamped status-specific field — without changing the boot header's presence semantics in any way. Then grow the smoke gate: add a steady-state scenario asserting `keeper status` (or its wire equivalent) carries a non-null event-store block against the sandboxed caught-up daemon, and record the scenario addition as an amendment line in ADR 0073 (its scenario set grows only by amendment). Fixture tests must construct frames mirroring both real shapes.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/server-worker.ts:2439 — computeEventStoreStatus (per-field null-honest; keep as-is) and its call site near :2351 stamping the boot block
- src/server-worker.ts stampBootStatus — the object-form-only stamping whose omission semantics must not change
- cli/status.ts:595, :660, :680 — the null seed, the onBootStatus capture, and the boot.event_store read that never fires at steady state
- test/slow/daemon-smoke.test.ts — the frame-contract scenario the new steady-state assertion joins

### Risks

- The restart CLI's caught-up predicate reads absent-boot-header as positive evidence; any change that re-stamps headers at steady state breaks it — deliver the block another way.

## Acceptance

- [ ] `keeper status --json` carries a non-null event-store block against a healthy caught-up daemon, proven in the smoke gate
- [ ] The steady-state absent-boot-header contract is unchanged and the restart verdict scenarios stay green
- [ ] ADR 0073 records the scenario-set amendment
- [ ] Focused status fixtures mirror both live frame shapes

## Done summary
Moved the event-store block off the ephemeral boot header onto the result frame (baked into the memo line at steady state, stamped on the object frame during catch-up), so keeper status delivers count/bytes/last-boot-catchup/projections against a healthy caught-up daemon; boot-header presence semantics unchanged. Grew the ADR 0073 smoke gate to assert steady-state delivery on the real wire; status fixtures mirror both frame shapes.
## Evidence
