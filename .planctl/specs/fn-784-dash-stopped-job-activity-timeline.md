## Overview

`keeper dash`'s AGENTS region today shows only `working` jobs plus
stopped-but-needs-you, sorted needs-you-first then `created_at` ASC. This
epic widens it to show ALL non-terminal jobs (working AND stopped) on one
unified "most recent activity started" timeline: a job rises to the top the
moment it starts a run and descends as newer runs start above it, jumping
back to the top on a genuine restart. The sort key is a new folded
`jobs.active_since` column stamped on the rising edge into `working`; each
row's leading glyph reuses the board's rolled-up job-state icons
(working / sub-agent / monitor / stale / idle), so the dash reads as a
brightness gradient of liveness ordered by recency.

## Quick commands

- `bun run test:full` — mandatory; the change touches db/migration, the
  collections wire descriptor, the reducer, and the dash view-model, all of
  which have slow-tier-only coverage.
- `bun test test/reducer-lifecycle.test.ts test/dash-view-model.test.ts test/schema-version.test.ts` — the three focused suites this epic extends.
- Manual smoke: run `keeperd` against a sandbox DB, drive a session through
  UserPromptSubmit→Stop→UserPromptSubmit, and watch the AGENTS row in
  `keeper dash` re-promote to the top on the second prompt.

## Acceptance

- [ ] `keeper dash` AGENTS region shows stopped (non-terminal) jobs as well as working ones.
- [ ] Rows sort by `COALESCE(active_since, created_at)` DESC with a `job_id` ASC tiebreak — one unified timeline; needs-you no longer affects ordering (annotation still renders).
- [ ] Each row's leading glyph is the per-job rolled-up board icon (working→sync, sub-agent-running→cogs, sub-agent-stale/monitor-stale→warn, monitor-running→eye, idle/stopped→circleO), computed uniformly for plan-linked and ad-hoc jobs.
- [ ] A job re-promotes to the top on a genuine stopped/terminal→working transition, holds position through mid-run churn, and a brand-new (never-prompted) job sorts by `created_at`.
- [ ] Schema bumped 64→65 with `65` added to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` in the same commit; `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1` (the fold + wire-through). If `active_since`
folds deterministically and reaches the snapshot via the collections
descriptor, the dash sort in `.2` is a pure view-model change. If it fails
(re-fold non-determinism, or the column never reaches the wire): re-examine
the rising-edge CASE and the `src/collections.ts` columns list before
touching the view-model.

## References

- `src/db.ts:2298-2302` — `last_input_request_at` v24→v25 add: the clean exemplar for the 6-layer folded-column ritual.
- `src/reducer.ts:5541-5557` — the sole `state='working'` write (UserPromptSubmit arm); the `start_time = CASE…END` right below it (`:5550-5553`) is the pattern to mirror for the rising-edge stamp.
- `src/readiness.ts:1296-1430` — the module-private per-job liveness predicates the rollup helper reuses.
- `src/icon-theme.ts:95-108` — the `running:*`→glyph map and `circleO`; all reused, no new glyph.
- SQLite `lang_update.html`: SET RHS expressions evaluate against pre-update row values, so a CASE reading the old `state` is safe.

## Docs gaps

- **README.md (~line 1015, `dash.ts` bullet)**: update the stale "needs-you-first then created_at ASC" / "working PLUS stopped-but-needs-you" prose to the unified `COALESCE(active_since, created_at)` DESC timeline with per-job board icons.
- **README.md `## Architecture` schema narrative (~1377-1500)**: add an "As of schema v65…" sentence for `jobs.active_since`.
- **README.md `## Inspect` jobs query comment (~2387)**: add `active_since` to the inline column list.
- **src/dash/view-model.ts `buildAgents` JSDoc (~392-397)**: rewrite to describe the new filter, sort key, and rollup glyph.

## Best practices

- **Stamp from `event.ts`, never `Date.now()`** — a wall-clock read shatters byte-identical re-fold. (keeper invariant + event-sourcing canon.)
- **Never backfill `active_since` from `updated_at`** — `updated_at` is bumped on every event ("last touched"), not "run started"; backfilling conflates them and is non-deterministic. Migration adds the column NULL with no backfill.
- **Rising-edge guard is `state != 'working'`, NOT `active_since IS NULL`** — the IS-NULL form stamps once forever and never re-promotes on restart, the opposite of the intended behavior.
- **Always include the explicit `ELSE active_since` branch** in the fold CASE, or a non-matching WHEN silently zeroes the column to NULL.
- **Stable compound sort key with `job_id` tiebreak** — equal `active_since` rows must not shuffle between frames (phantom movement); track selection by job id, not row index.
