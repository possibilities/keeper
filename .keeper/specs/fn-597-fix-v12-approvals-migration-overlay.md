## Overview

The v13 schema migration silently drops every approval decision recorded
under v12 because `migrate()` runs `DROP TABLE approvals` inside its own
`BEGIN IMMEDIATE` transaction BEFORE `runPlanctlApprovalMigration` (the
filesystem half) gets a chance to read those rows and overlay them onto
the matching plan files. The overlay pass is documented as part of the
v12→v13 migration contract but is dead-on-arrival in production. Capture
the sidecar rows before the DROP and thread them into the FS pass so the
overlay contract is actually honored, and add a realistic boot-path test
that would have caught the gap.

## Acceptance

- [ ] Approval rows present in the v12 `approvals` sidecar are overlaid
      onto the matching `.planctl/epics` and `.planctl/tasks` files when
      the daemon boots against a v12-shaped DB.
- [ ] The v12→v13 migration remains idempotent: a second boot is a no-op
      on already-migrated state and never double-applies or corrupts.
- [ ] A test exercises the realistic daemon boot path against a v12-shaped
      DB with live `approvals` rows and asserts the overlay lands in the
      plan files (closes the gap the author flagged in `test/db.test.ts`
      lines 1563-1573).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | v12→v13 migration silently drops sidecar rows; overlay contract is dead-on-arrival in production. Confirmed via `src/db.ts:763-768` (DROP inside migrate's transaction), `src/daemon.ts:114-126` (boot order runs FS pass after DROP), and the author's own acknowledgement in `test/db.test.ts:1563-1573`. |

## Out of scope

- Tier-0 findings (F2-F8) — the classifier filtered them as cosmetic,
  theoretical, or covered-by-F1; they do not warrant follow-up tasks.
- Any change to the v13 schema shape itself (the `epics.approval` column,
  the planctl-file `approval` field, or the RPC surface) — this follow-up
  only fixes the migration ordering, not the destination schema.
