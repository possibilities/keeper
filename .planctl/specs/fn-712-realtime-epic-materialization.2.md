## Description

**Size:** M
**Files:** src/db.ts, src/readiness.ts, src/autopilot-worker.ts, keeper/api.py, test/db.test.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, test/schema-version.test.ts

Introduce one shared "epic is materialized" predicate — `status IS NOT
NULL` (⇔ EpicSnapshot has folded) — consumed by the board (hide the shell
row) and the autopilot reconciler (refuse to dispatch against it), so both
wait for the same state. `status` is set to non-null at exactly one
reducer site (the EpicSnapshot UPSERT, src/reducer.ts:802/808); every
shell-INSERT writes NULL — so the predicate is an exact, re-fold-safe
discriminator with NO reducer/event-log change.

### Approach

- **Board (`default_visible`):** amend BOTH literals — the `CREATE_EPICS`
  DDL (src/db.ts:719) and the migration's `addGeneratedColumnIfMissing`
  literal (src/db.ts:~4065) — to
  `CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END`.
  KEEP the CASE wrap: the column is `NOT NULL` and `status` is nullable, so
  a bare predicate would compute NULL and violate the constraint.
- **Migration (forward-only, version-guarded, ONE `BEGIN IMMEDIATE`):**
  SQLite can't ALTER a generated-column expression in place, so:
  `DROP INDEX IF EXISTS idx_epics_default_visible` FIRST (the partial index
  references the column) → DROP the VIRTUAL column → re-ADD it via
  `addGeneratedColumnIfMissing` with the new expression → recreate the
  index. The DROP needs a `PRAGMA table_xinfo` presence check, NOT
  `table_info` (which excludes generated columns — `dropColumnIfPresent`
  would no-op wrongly). Converge fresh-DB (CREATE_EPICS literal) and
  migrated schema byte-identical. Optionally `PRAGMA quick_check` gated to
  the upgrade boot only.
- **Schema lockstep:** bump `SCHEMA_VERSION` by one from its CURRENT value
  at implementation time (currently 54; if fn-710 lands first it will be
  55 — bump to current+1) AND add that integer to keeper/api.py
  `SUPPORTED_SCHEMA_VERSIONS` in the SAME commit (test/schema-version.test.ts
  enforces; a miss fails every `commit-work` on the host).
- **Readiness:** add `{ kind: "epic-not-materialized" }` to the
  `BlockReason` union (src/readiness.ts:215). Add an EARLIEST predicate
  (`epic.status == null → blocked epic-not-materialized`) in BOTH
  `evaluateTask` (above predicate 2 `epic-not-validated`, :553) and
  `evaluateCloseRow` (above predicate 2, after the terminal-completed
  predicate 1, :806/:811). Add a `formatReasonShort` case (:1614/:1643) —
  the exhaustiveness `never` guard fails the build otherwise.
- **Autopilot:** `verbForVerdict` (src/autopilot-worker.ts:~576) already
  returns null for every blocked reason except `job-pending`, so the new
  reason is non-dispatchable automatically — NO code change, but add a
  pinning test for `close` and `task`.

### Investigation targets

**Required** (read before coding):
- src/db.ts:61 — `SCHEMA_VERSION`
- src/db.ts:719 — `CREATE_EPICS` `default_visible` literal
- src/db.ts:~4065 — migration `addGeneratedColumnIfMissing` literal (v31→v32 comment explains the CASE-wrap NULL reasoning)
- src/db.ts:615/686 — `idx_epics_default_visible` + `CREATE_EPICS_INDEXES` (always-run)
- src/db.ts:1679 — `addGeneratedColumnIfMissing` (table_xinfo); :1702 — `dropColumnIfPresent` (table_info, can't see gen-cols)
- src/db.ts:2070 — migrate `BEGIN IMMEDIATE`; :2061 — preMigrateStoredVersion branch
- src/readiness.ts:215 — `BlockReason` union; :553 — evaluateTask pred 2; :806/:811 — evaluateCloseRow pred 1/2; :1614-1656 — `formatReasonShort` exhaustiveness
- src/autopilot-worker.ts:~576 — `verbForVerdict`
- keeper/api.py:203-228 — `SUPPORTED_SCHEMA_VERSIONS`
- src/reducer.ts:802/808 — status set ONLY by EpicSnapshot UPSERT (the materialized invariant)

**Optional:**
- src/collections.ts:345 — `default_visible = 1` defaultClause (behavior follows the column; no code change)

### Risks

- Dropping a VIRTUAL generated column is UNPRECEDENTED in this repo; a
  mid-step throw inside the migrate transaction wedges the daemon at boot.
  Mitigate: table_xinfo presence check, DROP INDEX first, all in one
  BEGIN IMMEDIATE, version-guarded, before the `meta` version stamp.
- `SCHEMA_VERSION`/api.py drift breaks every `commit-work` on the host —
  both edits in one commit.
- SCHEMA_VERSION collides with fn-710's bump — the epic dep serializes this
  behind fn-710 so the numbers don't fight.

### Test notes

- db.test.ts: a `status IS NULL` epic computes `default_visible = 0` and is excluded from `WHERE default_visible = 1`; a status-set epic still qualifies; EQP still `SEARCH ... USING (COVERING )?INDEX idx_epics_default_visible`, no `USE TEMP B-TREE`; fresh-vs-migrated schema parity.
- readiness.test.ts: status:null → blocked `epic-not-materialized` in both perTask and perCloseRow; status:"open" unblocks the materialized gate (falls through to epic-not-validated etc.); precedence over `epic-not-validated`.
- autopilot-worker.test.ts: `verbForVerdict("close"|"task", blocked:epic-not-materialized) → null`.
- schema-version.test.ts: green with the bumped version.

## Acceptance

- [ ] `default_visible` computes 0 for a status-NULL epic and 1 for a materialized open/unapproved epic, identical on fresh-DB CREATE and migrated paths
- [ ] The forward-only migration drops+recreates the VIRTUAL column and `idx_epics_default_visible` inside one `BEGIN IMMEDIATE`, version-guarded, using a `table_xinfo` presence check; daemon boots clean
- [ ] `SCHEMA_VERSION` bumped by one and the new value added to keeper/api.py `SUPPORTED_SCHEMA_VERSIONS` in the same change
- [ ] `BlockReason` gains `epic-not-materialized`; `evaluateTask` and `evaluateCloseRow` return it (status==null) ranked above `epic-not-validated`; `formatReasonShort` renders it; `verbForVerdict` returns null for it (pinned by test)
- [ ] A null-status shell epic is hidden from the default board AND is non-dispatchable (worker and closer); once the EpicSnapshot folds it appears and becomes eligible — same predicate both sides
- [ ] `bun test test/db.test.ts test/readiness.test.ts test/autopilot-worker.test.ts test/schema-version.test.ts` green

## Done summary
Added a shared status-IS-NOT-NULL 'epic is materialized' gate: default_visible (CREATE_EPICS + v31->v32 literal) now hides NULL-status shell rows via a v55->v56 drop+re-add migration (one BEGIN IMMEDIATE, table_xinfo presence check, quick_check); SCHEMA_VERSION 55->56 with keeper/api.py lockstep; readiness gains epic-not-materialized ranked above epic-not-validated on both task and close-row paths, non-dispatchable via verbForVerdict (pinned).
## Evidence
