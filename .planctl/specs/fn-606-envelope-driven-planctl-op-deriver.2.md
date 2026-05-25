## Description

**Size:** M
**Files:** src/db.ts, test/db.test.ts

### Approach

Add a v19→v20 migration block in `src/db.ts:migrate()` (current ALTER slot — `SCHEMA_VERSION = 19` at line 56). Mirror the v13→v14 template at src/db.ts:1010-1253 exactly: version-guard reading the meta(schema_version) row written by a prior migrate(), uncached `db.run()` everywhere (per bun:sqlite #1332 — still open as of 2026-01), `WHERE planctl_op IS NULL` idempotency on Pass 1 for partial-run resume, ANALYZE epilogue. The outer migrate() block is transaction-wrapped by the caller per CLAUDE.md "Migrations are forward-only" rule.

**Pass 0 (new for v20):**

```sql
UPDATE events
   SET planctl_op = NULL,
       planctl_target = NULL,
       planctl_epic_id = NULL,
       planctl_task_id = NULL,
       planctl_subject_present = NULL
 WHERE hook_event = 'PreToolUse'
   AND tool_name = 'Bash'
   AND planctl_op IS NOT NULL
```

Wipes every PreToolUse:Bash row's structurally-wrong stamps. Idempotent re-run safe (the IS NOT NULL predicate becomes a no-op after the first pass). Required because v13→v14 stamped these rows from the now-broken input-command regex; leaving them populated would have the reducer's hook-event-agnostic `planctl_op != null` gate fire fan-out from wrong-shaped data.

**Pass 1 — re-stamp from PostToolUse:Bash rows.** Mirror the v13→v14 Pass 1 (lines 1018-1073) but select `hook_event = 'PostToolUse' AND tool_name = 'Bash' AND planctl_op IS NULL`. For each row: JSON.parse the `data` blob, run the new (post-task-1) `extractPlanctlInvocation` to extract the envelope (it's already gated correctly), UPDATE the five sparse columns. IS NULL idempotency guards against partial-run resume.

**Pass 2a — per-session `jobs.epic_links` re-derive.** Unchanged from the v13→v14 template (lines 1091-1195): `SELECT DISTINCT session_id WHERE planctl_op IS NOT NULL`, load each session's invocations + `/plan:plan` window-opener timestamps, feed `deriveEpicLinks`, UPDATE `jobs.epic_links`. Orphan sessions (planctl events with no SessionStart) skip — no shell-insert into `jobs`.

**Pass 2b — per-touched-epic `epics.job_links` re-derive.** Unchanged from the v13→v14 template (lines 1197-1246): for each touched epic, run `deriveJobLinks` over the per-session invocations + windows map, shell-INSERT the epic row if missing (mirrors `syncJobIntoEpic` pattern; ON CONFLICT carve-out at the EpicSnapshot fold preserves `job_links`).

**Epilogue:** `db.run("ANALYZE events")`. Refreshes `sqlite_stat1` so the first post-upgrade query lands the `idx_events_planctl_session` partial composite index instead of a table scan. Same as v13→v14 line 1253.

**Bump `SCHEMA_VERSION = 20`** at src/db.ts:56.

**Leave the v13→v14 backfill block (src/db.ts:1010-1253) UNCHANGED.** Its old `extractPlanctlInvocation` call at line 1048 will return null on every PreToolUse:Bash row after task 1 (the new deriver only fires on PostToolUse:Bash), so the v14 pass becomes a harmless no-op on fresh installs running the whole migration chain. The v20 block overwrites whatever it produced anyway. Historical comments at lines 1018-1030 stay as legacy context.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:1010-1253` — v13→v14 backfill block (structural template — mirror pass shape and comment style exactly)
- `src/db.ts:56` — `SCHEMA_VERSION` constant
- `src/db.ts:1261` — schema-bump rule comment ("Bump SCHEMA_VERSION only when adding an ALTER")
- `src/derivers.ts` — post-task-1 `extractPlanctlInvocation` (Pass 1 calls this)
- `src/plan-classifier.ts` — `deriveEpicLinks` / `deriveJobLinks` / `normalizePlanctlOp` (Pass 2a/2b reuse — unchanged contract beyond task 1's scaffold-as-creator addition)
- `CLAUDE.md` Event-sourcing invariants — "Migrations are forward-only" rule

**Optional** (reference as needed):
- `test/db.test.ts:1702-1938` — v14 migration test; new v20 test parallels its shape
- `test/reducer.test.ts:3159` — re-fold determinism test; v20 must preserve

### Risks

- Backfill iterates over every PostToolUse:Bash row (~thousands on a long-lived DB). Each row triggers JSON.parse + envelope-presence check. One-shot at boot; modest blocking spike (estimate single-digit seconds for ~10k rows), no ongoing cost.
- Crash mid-backfill: version guard remains < 20 and re-runs from the start. Pass 0 is idempotent (IS NOT NULL filter becomes no-op after first run); Pass 1 is IS NULL-idempotent; Pass 2a/b is full-replace re-derive (idempotent by construction).
- The v13→v14 block's `extractPlanctlInvocation` call becomes a no-op after task 1 lands (new deriver only fires on PostToolUse:Bash). Confirmed harmless — v20 supersedes its output. Document this in the v20 block comment.
- `idx_events_planctl_session` partial composite index gated on `planctl_op IS NOT NULL`: v20 NULLs out PreToolUse rows then re-stamps PostToolUse rows. Net index size roughly unchanged. ANALYZE epilogue refreshes stats.

### Test notes

- New `test/db.test.ts` test parallel to the existing v14 test at lines 1702-1938. Seed: a v19-shape DB with hand-stamped PreToolUse:Bash rows (with the structurally-wrong shape — `op="epic"`, `target="close"`, etc.) plus matching PostToolUse:Bash rows with envelope-bearing stdout. Run `openDb` to trigger migrate.
- Assertions: post-migration, all PreToolUse:Bash rows have NULL `planctl_*` columns; PostToolUse:Bash rows have correctly-stamped columns (target = real epic/task id, op = bare/hyphenated form per planctl's emit pattern); `jobs.epic_links` and `epics.job_links` reflect the new classifier output including scaffold → creator edges.
- Re-fold determinism guard: after migration, rewind the reducer cursor, DELETE projection rows, re-drain, assert byte-identical projection (matches test/reducer.test.ts:3159 invariant against the v20-migrated event log).
- End-to-end seed: include at least one scaffold event in the fixture so the scaffold-as-creator predicate is exercised through the full backfill path (not just the unit test in task 1).

## Acceptance

- [ ] `SCHEMA_VERSION = 20` in src/db.ts
- [ ] v19→v20 migration block added in `migrate()` mirroring the v13→v14 template (version-guarded; Pass 0 NULL-out → Pass 1 re-stamp → Pass 2a per-session jobs.epic_links → Pass 2b per-epic epics.job_links → ANALYZE epilogue)
- [ ] All Pass UPDATEs use uncached `db.run()` per bun:sqlite #1332 guidance
- [ ] Pass 1 uses `WHERE planctl_op IS NULL` for partial-run resume idempotency
- [ ] v13→v14 backfill block (src/db.ts:1010-1253) untouched (its now-no-op `extractPlanctlInvocation` call documented as harmless legacy)
- [ ] New test/db.test.ts test seeds PreToolUse + PostToolUse rows, runs migrate, asserts PreToolUse stamps cleared and PostToolUse stamps applied
- [ ] Test seeds a scaffold event; post-migration `epics.job_links` contains a `{kind: "creator", job_id: …}` entry from that scaffold
- [ ] On a live keeperd reboot against the production DB, `SELECT COUNT(*) FROM epics WHERE json_array_length(job_links) > 0` returns > 0 (today it returns 0)
- [ ] `scripts/board.ts` renders creator/refiner lines on existing epics; render commit 25f8a53 is the consumer
- [ ] Re-fold determinism preserved — test/reducer.test.ts:3159 stays green

## Done summary

## Evidence
