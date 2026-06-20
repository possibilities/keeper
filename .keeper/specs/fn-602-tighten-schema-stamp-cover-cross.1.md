## Description

Source finding: F1 (SCHEMA_VERSION bumped without a guarded ALTER step).

Evidence path: `src/db.ts:56` (the `SCHEMA_VERSION = 15` constant) and
`src/db.ts:485` (the `CREATE TABLE IF NOT EXISTS git_status` block in
the unconditional bootstrap). Commit `7e6cb35` bumped the constant when
adding `git_status`, but `migrate()` carries no `if (storedVersion < 15)`
block — the table creates idempotently on every boot via the
unconditional CREATE. The bare bump violates the CLAUDE.md invariant
("Bump `SCHEMA_VERSION` only when adding an ALTER block") and silently
no-ops any future real v14 to v15 ALTER on already-stamped DBs.

Pick one fix:

1. Downgrade `SCHEMA_VERSION` to 14. The `git_status` CREATE is
   idempotent and runs every boot. When a real ALTER lands next,
   bump to 15 plus add the guarded block in one pass.
2. Add a no-op `if (storedVersion < 15)` block in `migrate()` whose
   body just stamps the version with a comment along the lines of
   "v14 to v15: registers `git_status` table (created in the
   unconditional bootstrap block above)".

Option 1 is the smaller diff. Either restores the invariant.

## Acceptance

- [ ] `SCHEMA_VERSION` stamp is honest about what it gates (downgraded
      to 14, or paired with a guarded v14 to v15 block that documents
      the gate).
- [ ] All existing tests pass; no migration drift on DBs that are
      already stamped v15.

## Done summary
Added a comment-only no-op block in migrate() between the v13→v14 and v15→v16 steps documenting that the v15 stamp gates the unconditional CREATE_GIT_STATUS bootstrap (idempotent CREATE TABLE IF NOT EXISTS), restoring the 'bump only when adding an ALTER block' invariant.
## Evidence
