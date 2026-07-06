## Overview

The plan-validation marker `last_validated_at` doubles as autopilot's dispatch
gate, but every structural mutation verb re-stamps it after its post-write
integrity check — including ARMING a freshly-scaffolded ghost epic before its
deps are wired, which lets autopilot dispatch work early (readiness ranks the
validation gate above the dep checks). This epic turns the marker into a strict
one-way latch: mutation verbs keep their post-write integrity gate but never
touch the marker; arming is exclusive to the trailing `validate --epic` /
`armEpicValidated`, un-arming to the two invalidate paths. Any interleaving of
scaffold / cell-select / dep-wiring is then dispatch-safe by construction.

## Quick commands

- `cd plugins/plan && bun test test/verbs-restamp.test.ts` — the arm-exclusivity conformance cases
- `cd plugins/plan && bun test && bun run lint && bun run typecheck` — full fast gate

## Acceptance

- [ ] A ghost epic stays a ghost through every structural mutation verb; only the `validate --epic` arm flips it
- [ ] An armed epic's marker is never rewritten by mutation verbs; the invalidate paths remain the only un-arm
- [ ] Source names and docs state the latch contract; no surface claims mutation verbs stamp the marker

## Early proof point

Task that proves the approach: `.1` (sole task). If the void-return refactor
surfaces a hidden consumer of the returned stamp, fall back to returning the
prior on-disk value unchanged without ever writing it — the latch semantics
hold either way.

## References

- `fn-1122-suite-baseline-store` (overlap) — both edit plugins/plan/CLAUDE.md (different sections); dep-wired for fan-in safety
- `fn-1129-autopilot-escalation-agent-dispatch` (overlap) — both edit plugins/plan/README.md (different sections); dep-wired for fan-in safety
- docs/adr/0006-validation-marker-arm-exclusive-latch.md — the recorded decision (arm-exclusive latch, refresh removed)

## Docs gaps

- **plugins/plan/CLAUDE.md**: rewrite the "Validation marker" paragraph in place — latch semantics, correct 12-verb count, refresh language gone
- **plugins/plan/README.md**: assign-cells blurb drops "then re-stamps `last_validated_at`"; validate section states arm exclusivity
- **plugins/plan/skills/plan/SKILL.md**: Phase 7 rationale narrating add-deps arming ("re-stamps only when it writes >=1 edge") is stale post-fix

## Best practices

- **One-way latch over timestamp recency:** readiness derives from an explicit set-once transition, never from mutation-timestamp side effects — reusing a generic write timestamp as a gate makes every write a hidden state transition [k8s readiness-gate model]
- **Interleaving-invariant publish:** correctness must not depend on verb ordering; the draft stays invisible until one cheap atomic arm at the end [set-once/CAS latch pattern]
- **Deterministic race tests:** pin the exact incident interleaving as a no-sleep unit case; test idempotent arm (N validates -> one transition)
