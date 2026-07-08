# 22. Explicit-version schema step ladder

## Status

Accepted.

## Context

`migrate()`'s middle section was one long interleaved block of `if
(storedVersion < N)` guards, each hand-typing its own version number inline.
`SCHEMA_VERSION` was a second hand-typed constant that had to agree with the
highest guard, and `keeper/api.py`'s `SUPPORTED_SCHEMA_VERSIONS` whitelist was
a third hand-maintained copy of the same number — three silent surfaces that
could drift with no structural check catching a mismatch. ADR 0020 rests on
the same interleaved shape: the hand-renumber-at-merge mechanism it defines
must locate and reflow individual guards.

## Decision

Re-express the ladder as `SCHEMA_STEPS`, an ordered array of `{version, kind,
apply(ctx)}` entries applied in array order inside `migrate()`'s single
transaction. Each entry's `version` is EXPLICIT — recorded on the entry, never
derived from its position in the array — so a reorder can never silently
re-key a step. Every entry carries a machine-readable `kind` discriminant
(`additive` | `rewind` | `backfill` | `drop` | `noop`) classifying what the
step does to existing data; a downstream renumber tool refuses to mechanically
resolve a version collision on anything but a provably additive-idempotent
`kind`. `SCHEMA_VERSION` is a derived `export const` — the last entry's
`version` — so the next number is read off the ladder, never hand-typed.

Pure tests enforce the ladder's own well-formedness (unique, strictly
increasing, contiguous versions; max equals `SCHEMA_VERSION`) and its
agreement with the external whitelist (`keeper/api.py`'s
`SUPPORTED_SCHEMA_VERSIONS` must equal the derived version set) — a
derivability test, not a code generator.

### Rejected alternatives

- **Position-derived version numbers** (the array index is the version):
  every surveyed migration framework (Rails, Django, Flyway, Alembic,
  golang-migrate) treats a reorder that shifts keys as the canonical
  corruption path — a mid-ladder database re-runs or skips a step when
  position 7 stops denoting the same step it always denoted. An explicit
  per-step version with a derived max gives the same never-hand-typed,
  duplicates-structurally-caught property with none of that hazard.
- **Codegen writing the `api.py` whitelist from the TypeScript ladder**:
  clobbers the sanctioned per-version narrative comment block in `api.py`,
  fights Black formatting, and adds a build seam for a boot-time file that
  currently has none. A pure derivability test gets the same drift-proofing
  with zero generation machinery, at the cost of the whitelist staying
  hand-written (an accepted trade — see also the amendment note on ADR 0020).

## Consequences

- `SCHEMA_FINGERPRINT` is unchanged by this refactor — the recompute test
  passes without a re-pin, proving the extraction moved zero schema shape.
- The `kind` discriminant is now available for a downstream merge-time
  renumber tool to key its mechanical-vs-BLOCKED refusal check on, rather than
  re-deriving additive-idempotence from each guard's body.
- ADR 0020's provisional-numbering and trunk-keeps-its-numbers rule for a
  fan-in collision is untouched by this record; only the shape of the ladder
  a renumber operates on has changed.
