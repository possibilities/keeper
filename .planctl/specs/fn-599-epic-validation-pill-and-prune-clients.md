## Overview

Project `last_validated_at` (timestamp on `.planctl/epics/<id>.json`) through the full keeper data pipeline so the read-only board client renders a `[validated]` / `[unvalidated]` pill on each epic header. Also retire the two single-collection example clients (`scripts/epics.ts`, `scripts/jobs.ts`) — the combined `scripts/board.ts` covers their use.

## Quick commands

- `bun keeperd` then `bun scripts/board.ts` — confirm `[validated]` / `[unvalidated]` appears on each epic header line.

## Acceptance

- [ ] `epics` row carries a `last_validated_at` TEXT column (schema v14), populated from each planctl JSON via the existing producer→reducer chain.
- [ ] `scripts/board.ts` renders `[validated]` / `[unvalidated]` on every epic header line in every frame.
- [ ] Daemon restart does NOT trigger a synthetic `EpicSnapshot` re-emit per epic (the `seedFromDb` ↔ `buildEpicMessage` change-gate stays quiet).
- [ ] `scripts/epics.ts` and `scripts/jobs.ts` are deleted; README and all comment cross-refs are repointed at `scripts/board.ts`.
- [ ] From-scratch re-fold reproduces every epic row byte-identically including the new column.

## Early proof point

Task that proves the approach: task `.1`. If the seedFromDb symmetry fix doesn't suppress the re-emit storm on daemon restart, fall back to a synchronous post-migrate re-scan that establishes the change-gate baseline directly from disk (skipping `seedFromDb` entirely on the v13→v14 boot).

## References

- `fn-598` (overlap) — fn-598.3 also bumps `SCHEMA_VERSION` to v14 and touches `src/db.ts`; fn-598.5 touches `src/reducer.ts` (`EpicSnapshotBlob`, `extractEpicSnapshot`, INSERT/UPSERT) and the epics descriptor; fn-598.6 expects `scripts/jobs.ts` and `scripts/epics.ts` to exist for column-rendering docs — but this plan deletes them. Whichever lands second must rebase its SCHEMA_VERSION bump and adjust the docs scope to compensate.

## Docs gaps

- **README.md**: `## Example clients` (lines 234-287) — collapse to `board.ts`; intro at line 78 (`Three example clients ship in scripts/`) and line 232 (`Two example clients ship in scripts/`) — repoint; `## Architecture` line 347 schema-version anchor — update to v14 + name `last_validated_at`; `## Inspect` example `epics` query at line 410 — include the new column.
- **scripts/board.ts**: file header (lines 4-5, 13, 15, 67, 86-88) and HELP text (lines 106, 119, 121, 147) — drop "fuses epics.ts and jobs.ts" framing and "mirrors scripts/epics.ts" cross-refs; add the new pill to the HELP epic-header format example.
- **scripts/approve.ts**: lines 8 and 155 — repoint cross-refs at `board.ts`.
- **src/protocol.ts**: line 130 — example client reference.
- **src/server-worker.ts**: line 133 — `[epics-ts]` instrumentation TODO comment; verify it doesn't name a live trace prefix before rewriting/dropping.

## Best practices

- **bun:sqlite statement-cache pin (oven-sh/bun#1332):** inside the `migrate()` `BEGIN IMMEDIATE` transaction, use `db.run(sql)` for any statement referencing a column added in the same transaction. The codebase already follows this in the v9→v10 backfill — match that pattern if any in-transaction read is needed (none expected here since `addColumnIfMissing` is the only operation touching the new column).
- **No DEFAULT, no backfill, no rewind-and-redrain:** for a passthrough nullable field, the schema default of NULL is correct; the plan-worker's per-boot re-scan refreshes every epic via the change-gate diff. Adding a backfill would fabricate values that were never in the event log.
- **Embedded-shape determinism is task-element-scoped:** the embedded shape under `syncJobIntoEpic` is the **task** element, NOT an embedded-epic shape. `last_validated_at` is epic-level only and lives only at `epics` top-level — no second write site to modify.
- **JSON.stringify field-position byte-identity:** `seedFromDb`'s reconstructed message MUST place `lastValidatedAt` in the SAME object-literal slot as `buildEpicMessage`. Mismatch produces a serialized-diff every restart → one synthetic `EpicSnapshot` re-emit per epic, forever.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/epics-validation-pill-and-prune-clients` — sketch handoff bundle from `/arthack:sketch`; carries the curated sketch context.
