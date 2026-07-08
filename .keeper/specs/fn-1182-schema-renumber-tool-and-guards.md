## Overview

Build the merge-time convergence layer on top of the schema step ladder: a renumber tool
(scripts/rebase-schema-migration.ts) that mechanically rebases a lane's branch-local ladder
steps onto main's tip numbering when two lanes collide on a version — refusing unless every
colliding step is provably additive-idempotent — plus the resolver-charter carve-out that
lets a merge resolver invoke it instead of blocking for a human, and the plan-time guard
teaching epic-scout that the schema ladder is a singleton resource. Deliberately out of
scope (noted follow-up, not planned): a reconciler-level mutex serializing schema-bearing
lanes through the fan-in path.

## Quick commands

- `bun test test/rebase-schema-migration.test.ts` — pure-seam tool tests incl. the idempotency round-trip and every refusal case
- `bun run scripts/rebase-schema-migration.ts --help` — the tool's operator surface

## Acceptance

- [ ] The tool renumbers a colliding additive lane end-to-end (ladder entries, whitelist expectation, version assertions, fingerprint re-pin) and REFUSES with a machine-readable envelope on any non-additive collision
- [ ] Applying the tool twice is a no-op (idempotency round-trip)
- [ ] All three resolver-charter surfaces carry the same carve-out wording: version collision + tool exit 0 = mechanically clear; tool refusal or any schema SHAPE decision = BLOCKED as today
- [ ] epic-scout flags any two open epics that both imply a ladder bump and recommends a dep edge; the plan skill's spec conventions say migration versions are assigned at merge time

## Early proof point

Task that proves the approach: ordinal 1 — specifically its refusal gate over the ladder's
`kind` discriminants. If `kind` alone cannot classify a real historical step safely, stop
and re-litigate the discriminant contract with the operator before touching charters.

## References

- docs/adr/0020-schema-version-renumber-at-merge-time.md — the renumber rule this tool mechanizes
- Predecessor epic fn-1181-extract-schema-step-ladder — the explicit-version `SCHEMA_STEPS` ladder + `kind` discriminant this tool consumes (hard dependency)
- src/db.ts computeSchemaFingerprint — the re-pin oracle the tool's impure phase calls in-process

## Docs gaps

- **plugins/keeper/skills/autopilot/SKILL.md**: resolver bullet gains the tool carve-out (task 2)
- **plugins/plan/skills/deconflict/SKILL.md**: "no schema or migration edits" line reconciled with the tool path (task 2)
- **plugins/plan/agents/epic-scout.md**: schema-singleton overlap signal (task 3)

## Best practices

- **Renumber only never-applied steps** (Rails/Flyway consensus): the tool must only touch branch-local steps absent from main — trunk numbers are immutable [practice-scout]
- **Never re-pin a fingerprint to mask drift**: re-pin is legitimate only because a pure renumber leaves DDL semantics identical — the tool asserts that, not assumes it [Flyway repair pitfall]
- **Structured rewrite over regex-over-source**: the tool parses the ladder's structured entry shape (designed for this in the predecessor epic) rather than free-form AST/regex surgery
