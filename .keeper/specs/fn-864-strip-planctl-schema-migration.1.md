## Description

**Size:** M (large but one cohesive migration)
**Files:** `src/db.ts`, `src/derivers.ts`, `src/reducer.ts`, `src/daemon.ts`, `src/compaction.ts`, `src/types.ts`, `src/plan-classifier.ts`, `plugins/keeper/plugin/hooks/events-writer.ts`, `keeper/api.py`, `test/refold-equivalence.test.ts`, `test/schema-version.test.ts`

### Approach

The v77→v78 migration plus the full single-path flip of the schema/fold layer, in ONE atomic `.immediate()` transaction. **Decision A:** keep the `CREATE TABLE` literal AND the frozen ladder steps (`addColumnIfMissing("planctl_*")` at `db.ts:1805-1809`, `:2499`, `:2926` + their backfill SELECT/UPDATEs) as `planctl_*` — they are schema history; the v78 step renames forward via `renameColumnIfPresent`. **Decision B:** rename only the schema/envelope/fold-coupled symbols (this layer's files); the git-worker trailer parsers (`parsePlanctlOpTrailer`/`parsePlanctlTargetTrailer`), plan-worker dir-scan symbols, and `PlanctlCondition` are OUT of scope. **No cursor rewind** (value-preserving — the fn-831 pattern, NOT the fn-856 rewind+wipe). Mirror v78 into `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS in this same commit (`test/schema-version.test.ts` enforces).

### Investigation targets

**Required** (read before coding):
- `src/db.ts:392-402` (events cols), `:451`/`:583-584` (3 indexes), `:1009-1023` (commit_trailer_facts + index), `:1269` `renameColumnIfPresent` (+ the "rename BEFORE add" ordering comment near `:2547-2549`), the v77 block near `:3704-3744`, version stamp `:3746`, `insertEvent` prepared stmt `:3777-3793`, `serializePlanctlJson` `:3981` (do NOT route the envelope rewrite through it — it re-sorts keys)
- `src/derivers.ts:441` `extractPlanctlInvocation` (`PLANCTL_STDOUT_CAP` gate `:457`, `JSON.parse` `:474`), `:485` coalesce, `:1278-1299` second decoder reading `obj.planctl_op`
- `src/reducer.ts:2217-2236` commit_trailer_facts writer, `:5386` reader, `:5499-5503` events `planctl_*` SELECT, `:5232`/`:5243` coalesce
- `src/daemon.ts:557-567` INGEST_EVENTS_COLUMNS, `:1329-1331`/`:1378-1380` synthetic INSERT col lists, `:1686+` `$planctl_*` binds
- `src/compaction.ts:158` retention predicate; `src/types.ts:157-216` Event fields; `src/plan-classifier.ts:68` `normalizePlanctlOp`
- `plugins/keeper/plugin/hooks/events-writer.ts:555-565`/`:773-783`/`:656-681` (column list + binds + locals) — STRING rename only; keep dep-free (no `bun:sqlite`/`db.ts` import)
- `test/refold-equivalence.test.ts:480` insertEvent helper, `:767` rewind helper, `:926` legacy envelope test; `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS; `test/schema-version.test.ts`

### Detailed phases

1. **v78 schema block** (`if (preMigrateStoredVersion < 78)`): `renameColumnIfPresent` for all 7 `events` cols + 3 `commit_trailer_facts` cols; then `DROP INDEX IF EXISTS idx_events_planctl_*` + `CREATE INDEX IF NOT EXISTS idx_events_plan_*` (after the column rename — the WHERE predicate auto-rewrote on rename, so this is purely to rename the identifier); same for `idx_commit_trailer_facts_epic`.
2. **events.data rewrite** (same v78 block, in-tx): iterate rows with the legacy key present; parse `data` → parse `tool_response.stdout` (a JSON string) → if it carries `planctl_invocation`, rename that ONE key to `plan_invocation`, re-embed preserving surrounding bytes, `UPDATE`. Per-row try/catch — malformed/oversized = skip (never throw). Idempotent (re-run finds none). Then assert `SELECT count(*) ... LIKE '%planctl_invocation%' == 0` and throw loud if not. Touch ONLY the stdout envelope key — never `tool_input.command`.
3. **Readers/writers/types**: flip every `planctl_*` column reference + `types.ts` Event fields + drop the `?? planctl_invocation` coalesce (3 sites) + the second decoder + commit_trailer_facts reader/writer to `plan_*`.
4. **Lockstep column lists**: `insertEvent` stmt, daemon INGEST_EVENTS_COLUMNS + 2 synthetic INSERTs + binds, hook column list/binds/locals, compaction predicate → `plan_*`. A single missed list fails "no such column" on the next INSERT.
5. **Symbol rename** (schema/fold layer only): `extractPlanctlInvocation`, `PlanctlInvocation`, `mintPlanctlFileAttributions`, `syncPlanctlLinks` (+ `SyncPlanctlLinksAccum`, `formatSyncPlanctlFanout`, `extractPlanctlStateRepo`), `normalizePlanctlOp`, `serializePlanctlJson` → `plan*`. Leave trailer/plan-dir/await symbols.
6. **api.py** SUPPORTED_SCHEMA_VERSIONS += 78; `schema-version.test.ts`.
7. **Re-fold-equivalence proof** (the merge gate): mixed corpus (`planctl_invocation`-only legacy + `plan_invocation`-only new); run migration; assert from-scratch re-fold byte-identical to the pre-migration projection snapshot (value-equal across the column rename); spelling-equivalence test (two events, different spelling → identical projection); migration idempotency (run `migrate()` twice); index-predicate assertion (`SELECT sql FROM sqlite_master`); a `planctl_invocation`-only row that the rewrite converts.

### Risks

- Missing one column-list literal → "no such column" on the next event INSERT post-migrate. Sweep ALL (insertEvent, daemon ×3, hook, types, compaction).
- Dropping the coalesce while a row still carries `planctl_invocation` → silent NULL of that event's plan link (drift, NOT a throw). The in-tx rewrite + the `COUNT==0` assertion is the guard.
- Routing the rewrite through `serializePlanctlJson` re-sorts keys → breaks stdout byte-fidelity + the re-fold byte-identity gate. Minimal key-swap only.
- A throw inside the rewrite loop rolls back the whole v78 tx + wedges — per-row catch, never throw.
- The local DB is at v76: the next migrate runs v77 (rewind+wipe) THEN v78 in one call, then the boot re-fold rebuilds from 0 reading `plan_*` — so the reader flip + column rename MUST land in the same binary/deploy.

### Test notes

- `bun run test:full` is MANDATORY (db/daemon/hook/reducer paths). The re-fold-equivalence proof IS the merge gate.
- `events` has no triggers/views (confirmed) — RENAME is semantic-ambiguity-safe.
- DB backup is a human runbook step before the first LIVE migrate (see epic Rollout) — not automated here.

## Acceptance

- [ ] v78 block: 7 `events` + 3 `commit_trailer_facts` columns renamed via `renameColumnIfPresent`; 3 indexes DROP/CREATE-renamed; `events.data` envelopes rewritten (idempotent, per-row safe, stdout bytes preserved); `COUNT(planctl_invocation)==0` asserted; version stamp 78
- [ ] CREATE literal + frozen ladder steps LEFT as `planctl_*` (Decision A); a fresh 0→78 walk yields `plan_*` columns and passes
- [ ] All readers/writers/types/column-lists → `plan_*`; `?? planctl_invocation` coalesce dropped; schema/fold-layer symbols renamed; trailer/plan-dir/await symbols untouched (Decision B)
- [ ] `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS contains 78 (same commit); `schema-version.test.ts` green
- [ ] re-fold-equivalence proof extended (spelling-equivalence + migrated-vs-refold byte-identity + idempotency + index-predicate); `bun run test:full` green

## Done summary

## Evidence
