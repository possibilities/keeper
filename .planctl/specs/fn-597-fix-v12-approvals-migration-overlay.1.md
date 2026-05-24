## Description

Originating finding: **F1** (quality-auditor Critical). Evidence path used
in the vet:

- `src/db.ts:763-768` — inside `migrate()`'s v12→v13 step, `db.run("DROP
  TABLE IF EXISTS approvals")` runs inside the surrounding
  `BEGIN IMMEDIATE` transaction (line 791 specifically).
- `src/daemon.ts:114-126` — boot order is `openDb` (runs migrate, drops
  the table) → `runPlanctlApprovalMigration` (tries to read the table,
  finds nothing). The FS pass's `tableExists` guard returns false and
  the overlay loop is silently skipped.
- `test/db.test.ts:1563-1573` — the author's own comment block on the
  existing overlay test acknowledges the gap: "the sidecar table was
  dropped before we could read the rows from it inside the FS migration
  ... The realistic e2e path is tested via the daemon — here we exercise
  the two halves separately." The realistic e2e path is NOT covered.

Fix the ordering so the FS overlay sees pre-DROP rows. The auditor's
suggested approaches (pick whichever fits the existing code shape best):

1. Inside `migrate()`'s v12→v13 step, `SELECT * FROM approvals INTO`
   an in-memory snapshot (or a `TEMP TABLE approvals_pending_overlay`)
   BEFORE the DROP, and expose that snapshot to
   `runPlanctlApprovalMigration` (param, side-channel, or a TEMP table
   the FS pass reads instead of `approvals`).
2. Move the `DROP TABLE` step out of `migrate()` into a third phase
   that runs AFTER `runPlanctlApprovalMigration` completes.

Pick the approach that preserves the "schema migration is atomic
inside `BEGIN IMMEDIATE`" invariant (CLAUDE.md §migrations). Preserve
idempotency — a second boot on already-migrated state must still be a
no-op.

Then add a test that boots the daemon (or the boot sequence in
isolation via `drainToCompletion`) against a v12-shaped DB with live
`approvals` rows and asserts the overlay lands in the matching
`.planctl/epics/*.json` and `.planctl/tasks/*.json` files.

## Acceptance

- [ ] v12 sidecar rows are captured before `DROP TABLE approvals`
      executes (snapshot, TEMP table, or reordered DROP — author's
      choice).
- [ ] `runPlanctlApprovalMigration` consumes that captured set and
      overlays each row onto the matching plan file.
- [ ] Schema migration remains atomic / re-fold-safe / idempotent on
      re-boot.
- [ ] New test boots the realistic daemon path against a v12-shaped DB
      with seeded `approvals` rows and asserts the overlay lands in the
      plan files (not the existing two-halves-separately workaround).
- [ ] Author's TODO/CRITICAL comment block in `test/db.test.ts:1563-1573`
      is updated or removed to reflect that the gap is now closed.

## Done summary

## Evidence
