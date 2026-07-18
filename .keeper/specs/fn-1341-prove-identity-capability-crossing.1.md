## Description

**Size:** M
**Files:** cli/restart.ts, src/restart-observation.ts, test/restart-cli.test.ts, test/restart-observation.test.ts, test/restart-verb.test.ts, docs/problem-codes.md

### Approach

Replace nullable pre-restart identity with a closed evidence class: exact identity, positively served identity-incapable result, or unavailable/ambiguous. `parseRestartHealthFrame` recognizes the compatibility class only for a valid `type: result` response with either no boot header or a boot header whose Drain state is boolean and whose `boot_id`/pid/start-time fields are all absent; any partial, empty, wrong-typed, or contradictory tuple remains ambiguous. Freeze that class and a readable pre-ledger set of complete identities before issuing the one kickstart. In `classifyRestartEvidence`, preserve the exact branch byte-for-byte; the crossing branch waives only old-identity disappearance and proves that one complete successor was absent from the frozen set, has an exact durable boot row, completes Drain, and stays healthy under the existing twelve-second same-identity stabilization/reset rules. Short-circuit when proof completes, including success-with-`kickstart_warning`; add `proof_path: exact-replacement | identity-capability-crossing` to successful data. Keep existing top-level problem codes and bound the new reason diagnostics. Update the problem-code contract; do not expand the real-daemon scenario set.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts:175-185,327-375 — current two-state probe union and full-identity parser
- cli/restart.ts:293-324,506-543 — bounded ledger read and pre-kickstart snapshots
- cli/restart.ts:576-731,754-790 — monotonic polling, proof short-circuit, warning, and final routing
- src/restart-observation.ts:51-68,174-185,268-505 — input type, canonical identity equality, and exact classifier
- docs/adr/0086-positive-legacy-service-restart-crossing.md — exact crossing boundary and output contract
- test/restart-cli.test.ts:137-380 — injected-clock parser, legacy row, warning, and deadline fixtures
- test/restart-observation.test.ts:79-350 — fail-closed identity/ledger/stabilization matrix

**Optional** (reference as needed):
- src/protocol.ts:103-114,273-298 — optional boot header and identity fields for compatibility
- docs/problem-codes.md:15-31 — stable restart failure meanings
- test/slow/daemon-smoke.test.ts:320-487 — normal exact proof and negative control, which remain unchanged

### Risks

- Treating any omitted identity as compatibility creates a downgrade-by-outage path; require positive result framing and reject every partial tuple.
- Looking only at the latest pre-ledger marker can accept a successor already present in history; freeze membership over all valid identities in the readable snapshot.
- Borrowing pre-identity health or samples across successor identity changes weakens stabilization; begin and reset the existing timer only on complete identity-bearing caught-up observations.
- Adding a new top-level problem code or real-daemon scenario would widen the contract unnecessarily; keep diagnostics additive inside the existing bounded envelope and correctness suites.

### Test notes

Table-test absent boot, boot with Drain and zero identity fields, each partial identity permutation, malformed/non-result/transport unavailability, readable-empty versus missing/unreadable ledger, successor already in the frozen set, missing/mismatched durable row, Drain, identity churn, health gaps, stabilization, deadline, cancellation, and kickstart-warning precedence. Prove the normal exact branch's deep-equality fixtures remain unchanged except the additive proof path. Use injected clocks/probes/ledger only; no real daemon, UDS, subprocess, sleep, or new slow scenario.

## Acceptance

- [ ] The pre-restart parser emits three unambiguous evidence classes and admits compatibility only for a positively served result with the entire identity tuple absent
- [ ] A readable pre-ledger snapshot and successor-newness membership proof are mandatory on the crossing branch; missing, unreadable, partial, or reused evidence fails closed
- [ ] Both proof paths require one exact durable successor identity, completed Drain, uninterrupted health, and the existing stabilization interval; identity or health changes reset evidence
- [ ] Complete crossing proof returns early and can override kickstart failure only as success-with-warning, matching exact-proof precedence
- [ ] Successful envelopes carry the stable additive proof path and existing failure problem codes remain unchanged with bounded reasons
- [ ] Focused restart tests and typecheck pass without expanding the real-daemon gate

## Done summary

## Evidence
