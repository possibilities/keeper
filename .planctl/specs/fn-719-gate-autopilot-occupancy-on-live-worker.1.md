## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, test/reducer.test.ts, README.md

### Approach

Project a provenance-filtered `has_live_worker_monitor` boolean onto the
embedded job so readiness (task 2) can see it. The fact derives purely
from the event log — no fold-time wall-clock.

1. In `computeMonitors` (or a small pure sibling), derive
   `has_live_worker_monitor = monitors.some(m => m.kind !== "ambient")`
   (i.e. `kind in {monitor, bash-bg}`). The `kind` already exists on
   `MonitorEntry` today — NO dependency on fn-718.1's command/description
   enrichment for this filter.
2. Carry it onto the embedded `EmbeddedJobElement` (`src/reducer.ts:4125-4183`)
   via the `buildEmbeddedJob` OLD-element carve-out (`:4283-4312`),
   exactly like `last_commit_for_task_at` (fn-670 T2): it's a Stop-event
   fact on `jobs.monitors`, NOT a jobs-row field the embedded job
   naturally has, so lift it forward off the prior element across every
   `syncJobIntoEpic` re-sync — thread BOTH the epic-side and task-side
   arms (`:4342-4369+`) so a job-tick can't clobber it.
3. Schema bump `SCHEMA_VERSION` 58→59 (`src/db.ts:61`), WHITELIST-ONLY:
   the fact rides FREE in the opaque JSON-TEXT `tasks`/`jobs` cell — NO
   new real column, NO `addColumnIfMissing`. Use the v53 rewind-and-refold
   pattern (`src/db.ts:5288-5300`) to rebuild projections so existing rows
   gain the fact. Add `59` to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`
   (`:211-235`) in the SAME commit (keeper-py reads neither monitors nor
   this fact → whitelist-only, like v51/v53/v54).
4. Lease anchor: do NOT add a new timestamp — task 2's staleness floor
   reads the embedded job's existing `updated_at` (the monitors-only Stop
   write at `:6623-6683` bumps it, so for a stuck `stopped` session
   `updated_at` ≈ the last Stop ts). Flag in Risks that if `updated_at`
   proves too coarse, an explicit `snapshot_ts` is the fallback.
5. Terminal `ended`/`killed` already clear `monitors='[]'` (`:6789`,
   `:6847`), so the embedded fact auto-resolves to `false` on terminal —
   no extra work, just a test.
6. README: add the schema v59 narrative paragraph (style-match the
   v51/v53/v54 blocks); revise the v51 paragraph's "display-only"
   implication.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7487-7539 (`computeMonitors`) — derive the filtered boolean here
- src/reducer.ts:4283-4312 (`buildEmbeddedJob` carve-out) + :4125-4183 (`EmbeddedJobElement` shape) — where the fact lands
- src/reducer.ts:4342-4369+ (`syncJobIntoEpic` epic-side + task-side arms) + :2933-2950 (`foldCommit` carve-out spread reference)
- src/db.ts:61 (`SCHEMA_VERSION`), :5088-5099 (v51 ALTER template), :5288-5300 (v53 rewind-and-refold)
- keeper/api.py:211-235 (`SUPPORTED_SCHEMA_VERSIONS`)
- test/reducer.test.ts:15860-15911 (monitor harness: `getMonitors`, `insertBashBgLaunch`, `insertMonitorLaunch`, `insertStopWithTasks`, `drainAll`) + :15980-15990 (SessionEnd/Killed clear)

**Optional** (reference as needed):
- src/derivers.ts:269-272 (`MonitorEntry` — the `kind` the filter reads)
- src/reducer.ts:6623-6683 (Stop monitors-only write — bumps `updated_at`, the lease anchor)
- README.md:1376 (schema narrative), grep test/reducer.test.ts for the cursor-rewind / `DELETE FROM` / re-drain re-fold-determinism assertion

### Risks

- `updated_at` as the lease anchor is coarse (bumps on any job event); for a stuck `stopped` session the last event IS the Stop, so it holds — but if task 2 needs finer granularity, fall back to an explicit `snapshot_ts` carried alongside the boolean.
- Whitelist-only vs real column: default whitelist (fn-670 T2 precedent); only add a real `jobs` column if board display independently needs it (it doesn't — task 2 reads the embedded fact).
- Never throw inside the fold — `computeMonitors` already returns `'[]'` on malformed; the derive must preserve that.

### Test notes

Reducer fold tests (reuse the `:15860` harness): Stop with a `bash-bg`
monitor → embedded work job carries `has_live_worker_monitor=true`;
`monitor`-kind → true; `ambient`-only → false; terminal (ended/killed) →
false; carve-out preservation across a job-tick re-sync (the field
survives `syncJobIntoEpic`); from-scratch re-fold (rewind cursor, DELETE
projections, re-drain) reproduces byte-identical rows AND the v53-style
backfill converges to the same value.

## Acceptance

- [ ] A `computeMonitors`-derived `has_live_worker_monitor` (kind in {monitor, bash-bg}, ambient excluded) rides onto the embedded `EmbeddedJobElement` via the `buildEmbeddedJob` carve-out, threaded through both `syncJobIntoEpic` arms
- [ ] `SCHEMA_VERSION` 58→59 whitelist-only (no new real column); `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` gains 59 in the same commit; `test/schema-version.test.ts` green
- [ ] v53-style rewind-and-refold rebuilds existing projections; a from-scratch re-fold reproduces byte-identical rows; `ambient`-only never sets the fact
- [ ] Terminal (`ended`/`killed`) yields `has_live_worker_monitor=false` (rides the existing `monitors='[]'` clear) — test pins it
- [ ] README schema narrative updated (v59 paragraph added; v51 "display-only" implication revised)

## Done summary

## Evidence
