## Description

**Size:** S
**Files:** plugins/plan/template/_partials/worker-implement-native.md, plugins/plan/template/_partials/worker-implement-wrapped.md, src/daemon.ts, test/daemon.test.ts

### Approach

Make the worker-side base-gate verdict timeout-aware. `keeper baseline`
already hands the worker a discriminated verdict (green / suite-red /
infra-error / timeout) — the worker guidance simply never acts on the
distinction. Teach both worker partials (native and wrapped — they must
stay consistent; the work SKILL.md copy is generated, edit the
template/partials only) that a `timeout` or `infra-error` verdict is
INCONCLUSIVE: retry with backoff / escalate as tooling trouble, never
stamp `SHARED_BASE_BROKEN`; only a confirmed suite-red attests, mirroring
the daemon-side `classifyBaselineForRepair` precedent ("an infra-error or
timeout leaf is NEVER red for this purpose"). Evaluate a belt-and-braces
daemon-side guard in the worker-stamped candidate path
(`selectRepairCandidates` folds the free-text reason verbatim today) — if
a machine-readable timeout hint in the reason is needed, check the
`parseBlockedCategory` and `fingerprintFailure` reason-slot contracts
before widening them. Any starvation probing (wall-clock-vs-cpu, host
load) is a producer/worker-side signal only — it must never enter a fold
(re-fold determinism). The confirmed-red attestation path must not loosen.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1626-1682 — `selectRepairCandidates`: the worker-stamped candidate source that trusts the SHARED_BASE_BROKEN reason verbatim (the gap).
- src/daemon.ts:1706-1730 — `classifyBaselineForRepair` / `baselineRedIsConfirmed`: the timeout-never-red precedent to mirror, not reinvent.
- plugins/plan/template/_partials/worker-implement-native.md:38 — the worker base-gate guidance (primary edit surface); sibling worker-implement-wrapped.md:45 must stay consistent.
- cli/baseline.ts — the verdict surface the worker consults (timeout already distinct from suite-red).

**Optional** (reference as needed):
- src/baseline-store.ts:289 — `BaselineOutcome` discriminated union (the shape that cannot mis-classify).
- src/failure-fingerprint.ts:74 — `fingerprintFailure` (reuse; never a second fingerprint scheme).
- test/daemon.test.ts — `selectRepairCandidates` cases; a starved-attestation-defers test slots beside them.
- docs/adr/0017-trunk-repair-escalation-and-role-keyed-guard.md — the attestation/repair rationale home for any ADR note.

## Acceptance

- [ ] A worker whose base gate returns a timeout or infra-error verdict does not attest SHARED_BASE_BROKEN — the guidance routes it to retry-with-backoff or a tooling escalation instead.
- [ ] A confirmed suite-red base gate still attests SHARED_BASE_BROKEN exactly as before (no loosening of the safety net).
- [ ] Native and wrapped worker guidance agree on the new verdict handling.
- [ ] Any starvation/timeout signal consulted lives on the producer/worker side; no fold reads wall-clock, CPU time, or host load; fast suite green.

## Done summary

## Evidence
