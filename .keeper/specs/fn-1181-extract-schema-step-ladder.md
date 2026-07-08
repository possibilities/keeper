## Overview

Refactor `migrate()`'s interleaved migration ladder in src/db.ts into an explicit ordered
array of step entries — each `{version, kind, apply(ctx)}` with the version EXPLICIT (stable
step identity, never array-position-derived) — and derive `SCHEMA_VERSION` as the last
entry's version so the "next number" is never hand-typed on a lane. Duplicate or out-of-order
numbers become structural errors pure tests catch, and the keeper/api.py whitelist stops
being a hand-maintained second silent surface via a derivability test.

## Quick commands

- `bun test test/db.test.ts test/schema-version.test.ts` — ladder invariants, fingerprint recompute, fresh-vs-migrated identity, whitelist derivability all green
- `bun run typecheck && bun run lint`

## Acceptance

- [ ] `SCHEMA_VERSION` is a derived plain `export const` (ladder tail), byte-compatible with every existing import site
- [ ] `SCHEMA_FINGERPRINT` is UNCHANGED — the refactor provably does not move the migrated schema shape
- [ ] Every fresh-vs-migrated table-tail identity test passes unmodified
- [ ] Pure tests enforce: unique + strictly-increasing + contiguous ladder versions, max == SCHEMA_VERSION, api.py whitelist == derived set
- [ ] Every step carries a machine-readable `kind` discriminant (the downstream renumber tool's refusal check keys on it)

## Early proof point

Task that proves the approach: ordinal 1. If the extraction cannot keep the fingerprint
byte-stable, stop and re-litigate the entry boundary with the operator before continuing.

## References

- docs/adr/0020-schema-version-renumber-at-merge-time.md — anticipates exactly this follow-up in its Consequences
- src/db.ts SCHEMA_FINGERPRINT doc comment — the merge-loudness rationale
- Successor epic (planned this session): merge-time renumber tool consuming the `kind` discriminant and explicit-version entries

## Alternatives

- Position-derived version numbers: REJECTED — every surveyed migration framework (Rails/Django/Flyway/Alembic/golang-migrate) treats key-shifts-under-reorder as the canonical corruption path; a mid-ladder DB re-runs or skips steps when position 7 stops denoting the same step. Explicit per-step versions with a derived max give the same "never hand-typed, duplicates structurally caught" property with none of the hazard.
- Codegen writing the api.py frozenset from TS: REJECTED — clobbers the sanctioned per-version narrative comment block, fights Black formatting, adds a build seam. A pure derivability test gets the same drift-proofing with zero generation machinery.

## Rollout

Single-commit refactor; the byte-stable SCHEMA_FINGERPRINT is the canary (any shape drift
fails the recompute test before commit). No DB or daemon behavior change — a pure source
reorganization of boot-time code. Rollback is `git revert` of one commit. Downstream: the
sitter repo pins keeper's fresh-migrate DDL fixtures; byte-stability means no repin needed —
if the fingerprint moves, that assumption broke and the sitter fixture needs a coordinated
repin (scripts/emit-schema-fixture.ts).

## Docs gaps

- **docs/adr/0020**: Status gains a supersession/amendment note when the successor ADR lands (task 3)
- **CLAUDE.md Migrations**: the "THREE same-commit moves" bullet is REWRITTEN (file at byte cap — replace, never append) to the ladder + derived-constant reality (task 3)
- **CONTEXT.md**: glossary entries for the ladder vocabulary (task 3)
- **keeper/api.py narrative comment block**: stays hand-written (decision recorded in the successor ADR)

## Best practices

- **Step identity decoupled from ordinal** (Flyway/Alembic/Rails/Django consensus): position drives apply order only; the recorded key is the explicit version [practice-scout]
- **Never rewrite a fingerprint to mask drift**: a re-pin is legitimate only when the version prefix moved with a provably-identical DDL dump [Flyway repair pitfall]
- **SQLite has no ADD COLUMN IF NOT EXISTS**: addColumnIfMissing's pragma_table_info probe IS the idempotency — one column per call stays the rule
