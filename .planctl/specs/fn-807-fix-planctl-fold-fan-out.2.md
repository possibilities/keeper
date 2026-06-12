## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, keeper/api.py, test/db.test.ts, test/reducer-links.test.ts, README.md

### Approach

New projection table `commit_trailer_facts(event_id INTEGER PRIMARY KEY, committer_session_id TEXT NOT NULL, planctl_op TEXT NOT NULL, planctl_target TEXT NOT NULL, planctl_epic_id TEXT, committed_at_ms INTEGER NOT NULL)` with indexes `(committer_session_id, event_id)` and `(planctl_epic_id, committer_session_id, event_id)`. Follow the module-scope CREATE-constants convention (src/db.ts:481 CREATE_V66_INDEXES, :900 CREATE_BUILDS): one `CREATE_COMMIT_TRAILER_FACTS` + index constants referenced by BOTH the fresh-create path and the v66→v67 ladder step so fresh and migrated DBs are schema-identical.

Live write: inside `foldCommit`'s existing transaction, INSERT the fact row whenever `extractCommit` yields non-null with `planctl_op` and `planctl_target` both non-null (the same re-assert the loaders use — deliberately WIDER than the `parsePlanRef(...).kind != null` gate at src/reducer.ts:2334 that triggers syncPlanctlLinks; the row condition must equal the loader/backfill condition exactly). `planctl_epic_id = parsePlanRef(planctl_target)?.epic_id ?? null`. Store `committed_at_ms` in MILLISECONDS as named; loaders derive `ts = committed_at_ms / 1000` exactly as today (src/reducer.ts:4895).

Migration v66→v67 (version-guarded `if (preMigrateStoredVersion < 67)`): create table + indexes, then backfill by iterating all Commit rows via `COALESCE(events.data, event_blobs.data)` LEFT JOIN (relocated blobs MUST backfill — src/reducer.ts:4873-4875 is the reference shape) through the SAME `extractCommit` + `parsePlanRef` JS path the live fold uses. Never a SQL `INSERT…SELECT json_extract` — Commit events carry NULL sparse planctl columns (facts live only in the payload) and parsePlanRef cannot be replicated in SQL. Backfill-only: NO cursor rewind (the projection derives from Commit events alone; identical rows by construction). Add a forward-facing comment: any future rewind-and-redrain DELETE block must include this table. Bump SCHEMA_VERSION 66→67 (src/db.ts:48) AND add 67 to SUPPORTED_SCHEMA_VERSIONS (keeper/api.py:258) in the SAME commit — test/schema-version.test.ts enforces.

Then switch `loadAllCommitTrailerFacts` (from task 1) to read the table `ORDER BY event_id ASC` — blob scans gone from the read path entirely. README: replace the sweep characterization in place (~83-84, 1395, 1996-2003) and add the compact v67 schema-history bullet (~1490-1940), forward-facing voice.

### Investigation targets

**Required** (read before coding):
- src/db.ts:48 (SCHEMA_VERSION), :481/:900 (CREATE-constants convention), :3333 (migrate transaction), :2950-2957 (rewind-block shape — for the future-rewind comment, NOT to add one)
- src/reducer.ts:2199-2356 — foldCommit; where the projection write lands
- test/db.test.ts:2286 — migration backfill test shape (hand-built prior-version DB, seed, migrate, assert, idempotence)
- keeper/api.py:255-260 — frozenset + doc-comment pattern per bump

**Optional** (reference as needed):
- src/compaction.ts:12-25 — blob-in-exactly-one-place invariant (migration holds the writer lock; no in-flight window)
- test/schema-version.test.ts — the cross-language guard

### Risks

- Backfill/fold divergence is the classic projection-consistency bug — both must route through extractCommit + parsePlanRef; the re-fold byte-identity test (fresh re-fold reproduces the backfilled rows exactly) is the gate.
- Old-binary downgrade: the existing migrate() pre-transaction throw covers v67 DBs opened by v66 binaries; do not weaken it.

### Test notes

Backfill test seeds inline, relocated, malformed, and non-planctl Commit rows in a v66-shaped DB; after migrate: facts rows correct (malformed + non-planctl skipped), indexes exist, second open idempotent. Re-fold test: wipe commit_trailer_facts + link projections, rewind cursor, drainAll, expect rows byte-identical to backfilled state. test:full mandatory (db.test.ts is slow-tier only).

## Acceptance

- [ ] commit_trailer_facts exists on fresh AND migrated DBs with identical schema; backfill covers relocated blobs and skips malformed/non-planctl payloads
- [ ] foldCommit writes the fact row in the same transaction; loaders read the table (zero Commit-blob scans in the fold read path)
- [ ] From-scratch re-fold reproduces the backfilled table byte-identically
- [ ] SCHEMA_VERSION=67 + keeper/api.py frozenset updated same commit; schema-version test green
- [ ] README sweep prose + v67 bullet updated in place; bun run test:full green

## Done summary
Added the v67 commit_trailer_facts projection: foldCommit writes one fact row per trailer-bearing Commit in its transaction, loadAllCommitTrailerFacts reads the indexed table instead of scanning every Commit blob per swept session, and the v66->v67 migration backfills it (no cursor rewind). Bumped SCHEMA_VERSION + api.py whitelist; updated README sweep prose + v67 bullet.
## Evidence
