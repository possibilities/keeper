## Description

**Size:** S
**Files:** src/daemon.ts, src/db.ts, test/db.test.ts

### Approach

Delete the v13 approval filesystem migration outright — both passes and the call
site. Post-fn-756 (schema v63) the `approval` field has zero consumers in keeper or
planctl, so the backfill serves nothing on ANY db version; and pass 2 (sidecar
overlay) is verifiably dead on every >=v13 DB (the `temp._v13_overlay_pending`
table is only populated by the v12->v13 migrate step). Do NOT gate instead of
delete: the call site has no pre-migrate version in scope, and a post-openDb
version read always sees the already-stamped current version (silent no-op gate).

Concretely:
1. Delete the call + its stale comment block at src/daemon.ts:1443-1454
   (`resolvePlanRoots()` stays if other consumers exist — grep first).
2. Delete from src/db.ts: `runPlanctlApprovalMigration` (6523-6625),
   `backfillEpicApproval` (6670-6706), the pass-2 overlay helpers
   (`overlayApprovalRow` etc.), and the `_v13_overlay_pending` temp-table
   snapshot inside the v12->v13 migrate step (~2784-2834) whose ONLY consumer
   is pass 2. KEEP the v13 SQL half itself (ADD COLUMN/DROP TABLE) version-guarded
   as-is — the forward-only ladder must replay identically on a fresh DB.
3. For each helper used only by the deleted code (`locatePlanctlEpicsDir`,
   `stringifyMigrationErr`, etc.): grep for other consumers; delete only if
   orphaned. `atomicWriteFile` / `serializePlanctlJson` likely have other
   consumers — verify before touching.
4. Rewrite test/db.test.ts:2622-2871 ("v12 DB migrates: ... file backfill +
   overlay applied, idempotent re-run") — it currently PINS the regression
   behavior. Replace with: (a) a v12 DB still migrates its SQL half cleanly to
   the current version, and (b) the new boot-safety pin below. Grep
   test/integration.test.ts for approval-migration references and update.

New durable pin: a test that boot never mutates `.planctl` trees — seed a tmp
planctl tree with post-fn-756-shaped epic JSONs (no `approval` field), run the
boot path that previously fired the backfill against a current-version DB, and
assert the tree is byte-identical after. If the test spawns the real daemon it
MUST build its env via `sandboxEnv(...)` (all five state paths).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1443-1454 — the unconditional call site + stale idempotency comment
- src/db.ts:6523-6625 — runPlanctlApprovalMigration (pass 1 FS backfill, pass 2 overlay)
- src/db.ts:6670-6706 — backfillEpicApproval (the regression writer)
- src/db.ts:2784-2834 — the v12->v13 migrate step: keep SQL, delete the temp-table snapshot feeding pass 2
- test/db.test.ts:2622-2871 — the test that pins the old behavior

**Optional** (reference as needed):
- test/helpers/sandbox-env.ts — required env builder for any daemon-spawn test
- CLAUDE.md "Migrations" section — forward-only ladder rules (no SCHEMA_VERSION bump here)

### Risks

- Deleting the temp-table snapshot inside the v12->v13 step: it is a read-only
  SELECT into TEMP, so schema output is unchanged — but verify the step still
  runs cleanly end-to-end on a hand-rolled v12 fixture (the rewritten test covers
  this).
- Do NOT resurrect any approval-writing path (fn-756); do not bump SCHEMA_VERSION
  (no keeper-py change in this epic).

### Test notes

`bun test test/db.test.ts` plus the new boot-safety test. The byte-identical
assertion should compare file bytes (or content hashes), not mtimes.

## Acceptance

- [ ] `runPlanctlApprovalMigration` / `backfillEpicApproval` and the pass-2 overlay code are gone; no caller remains (grep clean)
- [ ] a keeperd boot against a current-version DB leaves a seeded post-fn-756 `.planctl` tree byte-identical (new test)
- [ ] the v12->v13 SQL migration still replays cleanly (rewritten db.test.ts case)
- [ ] full `bun test` green; no SCHEMA_VERSION bump, no keeper-py diff

## Done summary
Deleted the v13 approval FS backfill (runPlanctlApprovalMigration + helpers + the v12->v13 TEMP overlay snapshot) and its daemon boot call site; kept the SQL ADD COLUMN/DROP TABLE half so the forward-only ladder replays. Rewrote db.test.ts to pin SQL-half-only migration plus a byte-identical boot-safety check.
## Evidence
