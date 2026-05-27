## Description

Finding f-003 (test/db.test.ts): CLAUDE.md's migration invariant states "A hook arriving against a missing/stale schema fails its INSERT and exits 0." Existing coverage:
- Line 139: migrate:false against a fully-migrated DB (happy path — insertEvent succeeds)
- Line 195: migrate:false against a fully-missing DB (empty file — prepareStmts throws "no such table: events")

The stale-schema case is untested: events table exists but newer columns (e.g. planctl_op, tool_use_id) are absent. This hits a different prepareStmts or insertEvent error path — column binding fails rather than table-missing — and is the scenario that occurs when the hook runs against a keeper DB last migrated on an older version.

Add a test that: (1) creates the events table with a minimal older column set (missing at least one column that insertEvent binds), (2) opens with migrate:false, (3) asserts the open or insert throws, (4) confirms the failure mode is distinct from the missing-table error at line 195.

## Acceptance

- [ ] Test exists for migrate:false against stale schema (events table present, newer columns absent)
- [ ] Test asserts the error is a column-binding or prepare failure, not "no such table"
- [ ] Hook outer-guard contract (exits 0 on throw) is documented or confirmed covered

## Done summary

## Evidence
