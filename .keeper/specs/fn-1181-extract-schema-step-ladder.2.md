## Description

**Size:** S
**Files:** test/schema-version.test.ts, test/db.test.ts

### Approach

Add the pure fast-tier tests that make ladder corruption structural: over `SCHEMA_STEPS`,
assert versions are unique, strictly increasing, contiguous from the ladder floor to the
tail, and that the tail equals `SCHEMA_VERSION`. Add the whitelist-derivability test: parse
keeper/api.py's `SUPPORTED_SCHEMA_VERSIONS` frozenset with the EXISTING
`readSupportedVersions()` regex parser and assert it equals the set derived from ladder
entry versions filtered to >= the Python floor (31). The existing membership-only test
stays membership-only — this is a NEW sibling assertion, not a conversion. api.py itself
stays hand-written; the test is what retires it as a silent surface.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/schema-version.test.ts:36 — readSupportedVersions() parser (reuse, do not duplicate)
- src/db.ts — SCHEMA_STEPS shape as landed by the predecessor task

**Optional** (reference as needed):
- test/db.test.ts fingerprint recompute test — the format-assertion pattern to mirror

### Risks

- The Python floor (31) is a contract of keeper-py's reader, not the ladder — pin it as a named const in the test with a comment pointing at api.py, so a future floor raise is a deliberate two-sided edit.

### Test notes

Pure in-process; no DB open needed except where an existing helper already provides one.

## Acceptance

- [ ] A failing case is impossible to land silently: duplicate, gap, reorder, tail/constant mismatch, and whitelist drift each fail a named fast-tier test
- [ ] The existing membership-only whitelist test is unmodified
- [ ] Full fast suite green

## Done summary
Added fast-tier tests pinning SCHEMA_STEPS ladder invariants (unique/increasing/contiguous versions, tail==SCHEMA_VERSION, valid kind discriminant) and a sibling whitelist-derivability test asserting keeper/api.py's SUPPORTED_SCHEMA_VERSIONS equals the ladder-derived set at/above the Python floor (31).
## Evidence
