## Overview

Surface the "epic was created by another epic's closer session" relationship as first-class projection fields on the `epics` table, and make the server's natural list order reflect it. Two columns: `created_by_closer_of TEXT` (the raw closer→child link — the closer's `plan_ref`, i.e. the closed epic's id) and `sort_path TEXT NOT NULL DEFAULT ''` (a zero-padded-6 dotted lexicographic key like `"000003.000007"`). The `EPICS_DESCRIPTOR.defaultSort` flips from `epic_number` to `sort_path`, so the existing generic `ORDER BY` template at `src/server-worker.ts:486` produces the slotted order with no code change. Board adds a `[slotted-after-closer]` pill on the epic header when `created_by_closer_of != null`. Autopilot inherits the new order for free without a single line of code change — `scripts/autopilot.ts` iterates `snap.epics` in server order and naturally grabs the follow-up before pre-existing peers in the same project.

## Quick commands

- `bun test test/reducer.test.ts -t "syncPlanctlLinks"` — exercise the fan-out + cascade
- `bun test test/db.test.ts test/collections.test.ts test/board.test.ts` — schema, descriptor, pill coverage
- `bun scripts/board.ts | head -20` — see the `[slotted-after-closer]` pill on a real frame
- `sqlite3 ~/.local/state/keeper/keeperd.db "SELECT epic_id, epic_number, sort_path, created_by_closer_of FROM epics ORDER BY sort_path ASC, epic_id ASC LIMIT 20"` — verify migration backfill produces the slotted order

## Acceptance

- [ ] Schema v28 → v29 ALTER adds `created_by_closer_of TEXT` and `sort_path TEXT NOT NULL DEFAULT ''` to `epics` via `addColumnIfMissing` (idempotent). `CREATE_EPICS` literal in `src/db.ts:442-458` lists both columns in matching order. Migration triggers a rewind-and-redrain (v25→v26 pattern) so existing event history re-folds with the new derivation in place.
- [ ] `syncPlanctlLinks` in `src/reducer.ts` derives both columns inside the existing `BEGIN IMMEDIATE` transaction from `(epic_number, job_links creator entries, jobs.plan_verb, jobs.plan_ref)`. Full transitive cascade re-stamps every descendant when a parent's `sort_path` changes; cycle guard caps depth at 50.
- [ ] Reducer never throws on missing parent / missing creator-job / malformed JSON / `epic_number ≥ 10^6` — every defensive read folds to a safe value and advances the cursor.
- [ ] `EpicSnapshot` ON CONFLICT carve-out in `src/reducer.ts:549-597` preserves both new columns alongside `tasks` / `jobs` / `job_links`. An `approval` RPC round-trip cannot wipe the derivation.
- [ ] `EPICS_DESCRIPTOR` in `src/collections.ts` adds both columns to `columns`, adds `sort_path` to `sortable`, and flips `defaultSort` from `{column: "epic_number", dir: "asc"}` to `{column: "sort_path", dir: "asc"}`. Docstring at `src/collections.ts:148-165` rewritten.
- [ ] `Epic` interface in `src/types.ts:611-666` gains `created_by_closer_of: string | null` and `sort_path: string` with JSDoc matching the `job_links` / `last_validated_at` precedent style.
- [ ] `scripts/board.ts` renders `[slotted-after-closer]` on the epic header line (after `[validated|unvalidated]`, before the readiness pill) when `row.created_by_closer_of != null`. `PILL_COLORS` gains `"slotted-after-closer": "active"` (cyan).
- [ ] `scripts/autopilot.ts` requires zero changes (verified by reading after the descriptor flip).
- [ ] Re-fold from scratch (rewind + DELETE FROM epics + drain, twice independently) produces byte-identical `(created_by_closer_of, sort_path)` for every epic row.
- [ ] README.md picks up three inline updates (schema v29 callout, pill list, SQL ORDER BY examples).
- [ ] `bun test` passes including new reducer / db / collections / board cases.

## Early proof point

The cascade + re-fold determinism test is the keystone — if the cascade fails to converge or a re-fold-from-scratch produces different bytes than the original online run, the whole architectural premise breaks. If it fails, the recovery is to revert to per-fold one-level cascade (option (a) in the planning conversation) and accept a documented re-fold edge case for descendants whose parent re-projects after them.

## References

- `fn-620` (overlap) — Mechanical git-cleanliness gate; in_progress on `src/reducer.ts` (`syncJobIntoEpic`, not our `syncPlanctlLinks`), `src/types.ts`, and `scripts/board.ts` (different pills). Same-file merge risk only — no logical blocker — but sequencing via `epic add-deps` is the safest path.
- `src/reducer.ts:2196-2399` — `syncPlanctlLinks` open-tx fan-out site (the canonical hook for the new derivation).
- `src/reducer.ts:549-597` — `projectPlanRow` `EpicSnapshot` ON CONFLICT carve-out (canonical spot to document the new excluded columns).
- `src/reducer.ts:1858` — example shape that SELECTs `plan_verb, plan_ref` off `jobs` for the creator-job lookup.
- `src/db.ts:2166-2217` — v27→v28 `git_dirty_count`/`git_orphan_count`: NOT NULL DEFAULT integer precedent matching `sort_path TEXT NOT NULL DEFAULT ''`.
- `src/db.ts:2139-2152` — v25→v26 spawn-name widening: rewind-and-redrain precedent when derived values need re-deriving from existing event history.
- GitLab `traversal_ids` / `BackfillNamespaceTraversalIdsOnIssues`: real-world topological backfill via plain JOIN UPDATE; same shape we adopt via SQLite recursive CTE in the migration (or via the rewind-and-redrain path, which keeper already has).

## Docs gaps

- **README.md ~502-523**: add `As of schema v29, the epics projection gains created_by_closer_of (TEXT) and sort_path (TEXT NOT NULL DEFAULT '')...` sentence in the schema-version callout block.
- **README.md ~306-335**: add `[slotted-after-closer]` to the epic header pills list.
- **README.md ~647-664**: update SQL examples that pin `ORDER BY epic_number ASC` to `ORDER BY sort_path ASC` (or note the default flip).

## Best practices

- **Materialized path with fixed-width segments + dot separator** is the right shape for pure sort-order use cases; nested set / closure table buy nothing when membership queries aren't needed. The dot (ASCII 46) being strictly less than digits (ASCII 48-57) is load-bearing for the prefix-sort invariant `"000003" < "000003.000007" < "000004"` (verified empirically under SQLite BINARY collation by practice-scout).
- **Width=6 ceiling at 999,999** is documented; the reducer's safe-fold (never throw inside BEGIN IMMEDIATE) handles overflow by writing `sort_path = ''` and stamping a stderr lifecycle note. The boundary won't realistically be hit in this control-plane use case.
- **Parent-missing fallback to `zeroPad6(epic_number)` (not `''`)** preserves a sensible root-level position during the transient window between child-fold and parent-fold; the cascade re-stamps the chain when the parent later projects.
- **Don't add columns to `JobLinkEntry`** — the existing link projection's key order is locked for re-fold determinism. `created_by_closer_of` is a top-level `epics` column, NOT a per-link field.
