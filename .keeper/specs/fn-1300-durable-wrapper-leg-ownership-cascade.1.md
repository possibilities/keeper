## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/birth-record.ts, test/provider-leg-ownership.test.ts, test/refold-equivalence.test.ts, test/reducer-projections.test.ts

### Approach

Land the durable layer of ADR 0071 inert: birth-record schema v2 (immutable `leg_launch_id`, `wrapper_job_id`, `wrapper_dispatch_attempt_id`, launcher pid + start-time; legacy classified by explicit protocol version, never null-field inference), the `provider_leg_ownership` registry projection (owner tuple, ownership-epoch event id, process identity, pane/generation coords captured at birth, launch/terminal/transfer settlement) and the `provider_leg_cascades` per-incident projection (TERM/KILL armed + sent timestamps, explicit kill-not-before deadline, attempt counts, blocked reason, page-once human_notified_at), their folds, the fenced ownership-transfer fold (refused once terminal proof exists or TERM armed; stale transfers no-op), and a release fold that re-verifies its own conditions (exact terminal-or-superseded owner proof, zero unresolved intents, every owned leg settled, claim tuple still current) before applying the existing exact compare-and-release. One SCHEMA_STEPS entry; re-pin SCHEMA_FINGERPRINT; version assigned at merge per ADR 0020 — never hardcode the next number.

### Investigation targets

*Verify before relying — these refs were planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0071-durable-wrapper-leg-ownership-and-terminal-cascade.md — the contract, field lists, and idempotency key
- src/birth-record.ts:58-86, 191-219 — current record shape + additive-compat parsing to extend
- src/reducer.ts:4801-4860 — DispatchClaimReleased exact compare-and-release the release fold composes with
- src/reducer.ts:4891-4936 — DispatchClaimSuperseded compare-and-transfer pattern to mirror for leg transfer
- src/reducer.ts:9240-9365 — SessionStart jobs-birth fold (attempt parsing, set-once launch facts)

**Optional:**
- test/reducer-projections.test.ts:2866-3198 — table-style fence/release coverage to extend
- test/db.test.ts:628-674 — schema defaults + fingerprint gates

### Risks

- Folds must stay deterministic/total: all cascade timestamps come from event payloads/`ts`, never wall-clock; malformed data folds safely.
- Projection growth: both projections are per-leg/per-incident bounded; settled rows must not accumulate unbounded history (idempotent per-key replace-merge).

### Test notes

Extend refold-equivalence over the new step; pure fixtures for transfer fencing (stale no-op, refused-after-TERM-armed), release-fold self-verification (each unmet condition blocks), legacy-version classification, and 1s-recycle corroboration data shape.

## Acceptance

- [ ] Birth records round-trip owner tuple + leg_launch_id + launcher identity, with legacy records classified by protocol version and never enrolled
- [ ] The ownership registry answers "all legs owned by attempt X" and the cascade projection persists signal deadlines/attempts across re-fold
- [ ] Transfer is refused once terminal proof exists or TERM is armed; stale transfers no-op deterministically
- [ ] The release fold blocks on any unmet condition and is an idempotent no-op on duplicates
- [ ] Deterministic re-fold equivalence holds; schema fingerprint re-pinned

## Done summary
Landed ADR 0071's durable layer inert: birth-record schema v2 owner tuple + version-based legacy classification, the provider_leg_ownership registry + provider_leg_cascades incident projections with their folds, the fenced ownership transfer, and an owned-leg release gate on DispatchClaimReleased; schema step v132, fingerprint re-pinned, re-fold equivalence proven.
## Evidence
