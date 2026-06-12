## Description

**Size:** S
**Files:** performance/watch.ts, lib/keeper-compat.ts, test/watch.test.ts

### Approach

Net-new behavior: today scan() never reads `meta.schema_version` — it
tolerates skew blind via prepareStmts:false. Add
`SUPPORTED_SCHEMA_VERSIONS = new Set([66])` (membership pin, the
keeper/api.py:258 pattern) and a degrade-don't-throw
`readSchemaVersion(db)`: absent table, absent row, or non-integer
value all fold to null — keeper's api.py RAISES here and the sitter
must NOT copy that (always-exit-0, never wedge the tick).

Add `detectSchemaSkew` as a pure detector: input
`{ observed: number | null, supported: Set<number> }`; null or
unlisted → one warning-severity finding. New `schema-skew` member in
the Category union; fingerprint keyed on
(category, `keeper-db::v<observed|unknown>`) so a version change
re-pages once and the seen-state cooldown holds it. Distinguish the
directions in detail/evidence text: observed > max(supported) =
"keeper ahead, update sitter whitelist" (the dangerous blind-scan
case); observed < min = "old DB". Gate scan(): on a skew verdict,
emit ONLY the skew finding and skip the DB-reading detectors that
tick (file/process probes may still run); the watchdog independently
guards liveness either way.

Tests: fixture DB at v66 → no finding; meta row bumped to 99 → skew
finding fires, DB detectors skipped; meta row deleted → folds to
null-skew finding, no throw. Plus a membership pin asserting the
fixture's version is IN the whitelist (the schema-version.test.ts
analog — fixture and whitelist must move together).

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:148-177 — the Category union to extend
- babysitters/performance/watch.ts:202-213 — fingerprint() contract (no timestamps/counts in the fp)
- babysitters/performance/watch.ts:1512-1560 — scan() structure, where the gate lands
- keeper/api.py:258,350-372 — the whitelist + meta read being mirrored (and its raise behavior being deliberately NOT copied)

**Optional** (reference as needed):
- test/schema-version.test.ts (keeper) — membership-pin test shape
- babysitters/performance/watch.ts:2402-2478 — tick()'s baseline/cooldown flow the new finding rides

### Risks

- FINGERPRINT_VERSION may need a bump if the new category interacts
  with held-gate categories; check HELD_TICK_CATEGORIES membership —
  skew should page immediately, not held.
- Carried-over seen.json predates the category: cold-start logic is
  already baselined, so a genuine skew after deploy pages once —
  verify, don't assume.

### Test notes

Covered in Approach; all green under `bun test`.

## Acceptance

- [ ] Unknown/unreadable schema_version → one warning `schema-skew` finding, DB-reading detectors skipped, tick exits 0
- [ ] v66 fixture → zero skew findings
- [ ] Whitelist-fixture membership pin test in place
- [ ] meta-read failure can never throw out of scan()

## Done summary
Added a schema-skew guard to the performance sitter: SUPPORTED_SCHEMA_VERSIONS whitelist + degrade-don't-throw readSchemaVersion, detectSchemaSkew pure detector, and a scan() gate that pages once and skips DB detectors on an unknown/unreadable schema_version. Tests cover v66-clean, bump-to-99, deleted-meta, and the whitelist/fixture membership pin.
## Evidence
