## Description

**Size:** S
**Files:** src/db.ts, test/db.test.ts, test/schema-version.test.ts, CLAUDE.md

### Approach

Cluster C. In migrate(), immediately after the preMigrateStoredVersion read
(src/db.ts:2349-2357) and BEFORE the .immediate() transaction opens, throw when
`preMigrateStoredVersion > SCHEMA_VERSION` with a message naming BOTH versions and
the remediation ("DB schema v<N> is newer than this binary's v<M> — deploy the newer
keeperd (or restore the matching binary); refusing to run rather than silently
downgrade"). Placement before the transaction means no version-guarded ALTER ever
runs against a newer schema and the meta stamp (:6166-6168) is unreachable. The
throw propagates uncaught out of openDb at daemon boot — a hard, loud crash and a
LaunchAgent restart loop until the operator intervenes is the INTENDED behavior
(forward-only, mechanized; no fatalExit wrapper needed, no silent read-only
fallback). Strengthen test/schema-version.test.ts:56-65 from
max(supported) >= SCHEMA_VERSION to membership (`toContain(SCHEMA_VERSION)`) —
api.py already lists 63, so it passes without an api.py edit. Add a db.test.ts case:
create a current DB, hand-stamp meta schema_version to SCHEMA_VERSION+1, assert
openDb throws with both versions in the message and the stored stamp is unchanged
afterward. CLAUDE.md "## Migrations": one sentence that the guard is enforced at
runtime. No SCHEMA_VERSION bump anywhere in this task.

### Investigation targets

**Required** (read before coding):
- src/db.ts:2349-2357 — preMigrateStoredVersion read (sqlite_master guard → 0 on fresh DB; 0 must NOT trip the guard)
- src/db.ts:6160-6170 — the unconditional meta stamp the guard must precede
- test/schema-version.test.ts:38-65 — readSupportedVersions + the max assertion to flip
- test/db.test.ts — existing openDb/migrate test shapes for the new downgrade case

### Risks

- Fresh DB reads version 0 — the guard is strictly-greater so 0 passes; keep it that way.
- Do not wrap in try/catch anywhere that would convert the crash into a degraded boot.

### Test notes

Covered in Approach; also run the full suite — many tests open sandbox DBs and must
be unaffected (their stored version is never > SCHEMA_VERSION).

## Acceptance

- [ ] DB stamped SCHEMA_VERSION+1 → openDb/migrate throws pre-transaction, message names both versions + remediation, stamp unchanged
- [ ] schema-version test asserts membership; CLAUDE.md Migrations updated
- [ ] full bun test green; no schema bump, no keeper-py diff

## Done summary
migrate() now throws pre-transaction when the stored schema_version exceeds the binary's SCHEMA_VERSION (both versions + remediation in the message), so an old keeperd refuses to silently downgrade a newer DB. Schema-version test flipped from max to membership; downgrade case added to db.test.ts; CLAUDE.md Migrations updated. No schema bump, no keeper-py change.
## Evidence
