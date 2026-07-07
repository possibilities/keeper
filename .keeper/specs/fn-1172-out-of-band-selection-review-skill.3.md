## Description

**Size:** M
**Files:** src/types.ts, src/db.ts, src/reducer.ts, src/plan-worker.ts, src/collections.ts, src/readiness-client.ts, src/board-render.ts, src/daemon.ts, cli/board.ts, cli/status.ts, keeper/api.py, test/board.test.ts, test/status.test.ts, test/reducer-projections.test.ts, test/reducer-plan.test.ts, test/collections.test.ts, test/readiness.test.ts, test/plan-worker.test.ts, test/db.test.ts, test/daemon.test.ts, test/watch.test.ts, test/schema-version.test.ts

### Approach

Sweep the `selection_review` column out of the epics projection and every consumer. The removal is a forward-only rewinding migration: drop the column, remove it from the schema literal and the reducer's epics upsert, and rewind-and-redrain the deterministic-replayed projections (wipe only that class — the fn-1123-era rewind blocks in db.ts are the precedent; live-only projections are never DELETEd). Historical plan-snapshot events that still carry the field must fold safely to the new shape — the fold reads around it, never throws. SCHEMA_VERSION bumps to the next free number after the in-flight lifecycle work (expected 114) with the keeper/api.py SUPPORTED_SCHEMA_VERSIONS entry in the same commit. Downstream consumers go quiet in the same change: the plan-worker overlay thread chain, the epics_selection_review readiness collection and its subscribe path, the board renderer's selection-review lines, the board CLI consumption, and the status envelope's needs_human.selection_reviews count — the status envelope's own schema version bumps since a field leaves the wire shape. This task shares no files with the plan-plugin tasks and lands independently; the epic-level deps sequence it after the in-flight reducer rewrite.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves; the reducer/db lines WILL have shifted after the lifecycle epic merges — re-locate by symbol.*

**Required** (read before coding):
- src/db.ts:1049-1054 (column), 2437/2484 (defaults), 6108-6127 (the migration that added it), 2883/3149 (v11/v17 rewind-block precedents)
- src/reducer.ts:526, 608-642, 7622 — fold production sites, post-rebase
- src/plan-worker.ts:1688-1727, 2108-2140 — the overlay coerce/thread chain (plus the scattered reads at 152/158/619/623/949/1294/1495/1546/2710/2947-2988)
- src/collections.ts:251-255, 355-380 and src/readiness-client.ts:198-205, 1761-1848, 2037-2078 — collection + subscriber removal
- src/board-render.ts:461-539, cli/board.ts:1072-1077, cli/status.ts:65, 197-203, 345-394, 571 — display surfaces and the status schema version
- keeper/api.py SUPPORTED_SCHEMA_VERSIONS + test/schema-version.test.ts — the same-commit whitelist contract

### Risks

- The rewind must wipe every deterministic-replayed projection that embeds epics data and none of the live-only ones — enumerate against the current rewind-block precedent rather than guessing
- grep caution: src/autopilot-worker.ts and src/reconcile-core.ts contain a NUL byte; use `rg -a` when sweeping for stragglers

### Test notes

The ten root suites listed in Files reference the field; update fixtures and assertions rather than deleting coverage. schema-version.test.ts enforces the api.py whitelist; status.test.ts pins the envelope schema version.

## Acceptance

- [ ] No keeper surface reads or writes epics.selection_review: board, status, readiness, plan-worker, daemon, collections
- [ ] A DB migrated from the prior version re-folds cleanly with historical selection-review-bearing events in the log; re-fold produces the new projection shape deterministically
- [ ] `keeper status` emits no needs_human.selection_reviews and its envelope schema version reflects the change
- [ ] SCHEMA_VERSION and keeper/api.py's whitelist advance together in one commit
- [ ] `bun test` (root) green

## Done summary
Swept epics.selection_review out of the projection and every consumer (reducer fold, plan-worker overlay chain, epics_selection_review collection, readiness/board/status surfaces, status envelope schema v7); DROP-COLUMN + rewind-and-redrain migration bumps SCHEMA_VERSION to 114 with the api.py whitelist entry.
## Evidence
