## Description

Fixes F1 (evidence: scripts/rebase-schema-migration.ts:477-484 and :593;
src/db.ts:4282-4295). computeRepinnedFingerprint() opens openDb(":memory:")
against the ../src/db module imported at process start, whose module-level
SCHEMA_VERSION reflects the pre-renumber (colliding) working tree. main()
calls it at :593 AFTER apply() produced the renumbered result.files.db, but
the module is never reloaded, so computeSchemaFingerprint (src/db.ts:4292)
prefixes and hashes with the stale tail (e.g. v116) while the written db.ts
re-imports to v117 — the schema-version/db.test.ts gate then recomputes
v117:<digest-over-v117> and mismatches the pinned v116:..., failing the
resolver's exit-0 commit on every real renumber.

Recompute the fingerprint from the rewritten ladder (result.files.db) rather
than the imported module snapshot: parse the post-renumber tail out of the
renumbered db.ts and prefix with it, or migrate a :memory: DB seeded from the
rewritten SCHEMA_STEPS, so both the vN prefix and the hashed input observe
the renumbered schema.

Also folds in F4: add the composed renumber -> re-pin regression test that is
currently missing — apply() tests never touch the fingerprint and
computeRepinnedFingerprint is only tested against the already-consistent
committed db.ts (no renumber in play), which is exactly how F1 escaped.

Files: scripts/rebase-schema-migration.ts (re-pin path),
test/rebase-schema-migration.test.ts (new composed test).

## Acceptance

- [ ] After a synthetic lane renumber, the pinned fingerprint equals a
      from-scratch recompute over the renumbered ladder's tail (prefix + digest).
- [ ] New test renumbers a synthetic colliding lane and asserts re-pin
      consistency; red before the fix, green after.
- [ ] Full fast suite + typecheck + lint green.

## Done summary

## Evidence
