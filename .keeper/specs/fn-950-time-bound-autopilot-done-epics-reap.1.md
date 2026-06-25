## Description

**Size:** M
**Files:** src/collections.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/collections.test.ts, test/server-worker.test.ts, CLAUDE.md, README.md

### Approach

Replace the count-bounded recently-done-epics read in
`loadReconcileSnapshot` with a time-bounded read using the existing
`recencyBound` descriptor mechanism (the same idiom proven on
`subagent_invocations`). The count `LIMIT 32` couples reap-visibility
safety to completion burst-rate; the requirement is a duration ("keep a
done epic visible through its done→idle close-row wind-down"), so a time
floor (`updated_at >= now - windowSec`) is the dimensionally-correct
bound. This is a read-time PRODUCER path (`loadReconcileSnapshot`), never
a fold — re-fold determinism is not at risk.

Steps:
1. In `src/collections.ts`, define `DONE_EPICS_REAP_WINDOW_SEC = 1800`
   next to `SUBAGENT_INVOCATIONS_RECENCY_SEC` (with a forward-facing doc
   comment on the window rationale: it must exceed a healthy close-row
   wind-down; tracks `MONITOR_RELEASE_SEC`). Add
   `EPICS_RECENT_DONE_DESCRIPTOR` — name `"epics_recent_done"`, table
   `"epics"`, and the SAME `columns`, `pk` (`epic_id`), `version`
   (`"last_event_id"`), `sortable`, and `jsonColumns` set as
   `EPICS_DESCRIPTOR` (MIRROR, do not minimize — `runQuery` projects only
   `descriptor.columns` and decodes only `descriptor.jsonColumns`, and the
   merged done rows are consumed as full `Epic` objects with
   `tasks`/`jobs`/`job_links`/`resolved_epic_deps`). Scope it to done via
   `defaultClause: { sql: "status = ?", params: ["done"] }` (or
   `defaultFilter: { status: "done" }`) — do NOT inherit
   `EPICS_DESCRIPTOR`'s `default_visible = 1` clause (that returns zero
   done rows). Set `defaultSort: { column: "updated_at", dir: "desc" }` to
   preserve the old `doneFrame` ordering (ensure `updated_at` is in the
   descriptor's `sortable` set). Add
   `recencyBound: { column: "updated_at", windowSec: DONE_EPICS_REAP_WINDOW_SEC }`.
   Register it in `REGISTRY`.
2. In `src/autopilot-worker.ts`, delete the manual `doneFrame`/`doneRes`
   block in `loadReconcileSnapshot` and source `doneEpics` from the
   generic helper: `const doneEpics = read("epics_recent_done") as unknown as Epic[];`.
   Keep the dedup-by-`epic_id` (open wins) merge and
   `orderEpicsForScheduling` seam UNCHANGED. The `read()` helper passes
   `(db, 0, frame)` with no `nowSec`, so `runQuery` defaults the recency
   cutoff to live `Date.now()/1000` — preserve that (a pinned/zero
   `nowSec` would make the floor always-true and silently restore
   unbounded behavior).
3. Remove `DONE_EPICS_REAP_LIMIT` from `src/autopilot-worker.ts`; import
   `DONE_EPICS_REAP_WINDOW_SEC` from `./collections` at the reference
   sites. Rewrite the constant's doc comment and the `loadReconcileSnapshot`
   exception note forward-facing (describe the time window; no
   change-history narration).
4. Refresh docs: the `recencyBound` example lists in `CLAUDE.md` (~line
   237) and `README.md` (~255-264) gain `epics_recent_done` on
   `updated_at` alongside `subagent_invocations`; the README
   `loadReconcileSnapshot` "merged recently-done epics read" sentence
   (~3206) restated as time-windowed. Edit `CLAUDE.md` in place
   (`AGENTS.md` is a symlink — never rm+recreate).

### Investigation targets

**Required** (read before coding):
- src/collections.ts:62-75 — `CollectionDescriptor` interface (`version` is required)
- src/collections.ts:166-233 — `EPICS_DESCRIPTOR` (mirror its columns/pk/version/sortable/jsonColumns; its `defaultClause` `default_visible = 1` is the ONE thing not to copy)
- src/collections.ts:362,380-404 — `SUBAGENT_INVOCATIONS_RECENCY_SEC` + `SUBAGENT_INVOCATIONS_DESCRIPTOR` (the recencyBound template to mirror)
- src/collections.ts:668-687 — `REGISTRY` + `getCollection`
- src/autopilot-worker.ts:1599-1646 — the `read()` helper + the `doneFrame` block to swap (keep dedup + `orderEpicsForScheduling`)
- src/server-worker.ts:1140-1144 — where `resolveFilter` applies `recencyBound`; :1263-1276 — SELECT projects `descriptor.columns` + decodes `jsonColumns` (why mirroring matters)

**Optional** (reference as needed):
- src/server-worker.ts:1324-1332 — `clampLimit` (`limit:0` = unbounded sentinel; the time floor is the sole bound)
- src/exit-watcher.ts — the dead-pid reprobe backstop that catches a closer wedged past the window

### Risks

- **Row-shape divergence (HIGH).** If the descriptor trims
  `columns`/`jsonColumns`, merged done rows lose
  `tasks`/`jobs`/`job_links`/`resolved_epic_deps` and the completion reap
  silently degrades. Mirror `EPICS_DESCRIPTOR` exactly.
- **Wrong done scope.** Inheriting `default_visible = 1` returns zero done
  rows. Use a `status='done'` clause.
- **Seconds-vs-ms unit trap.** `updated_at` folds from `event.ts` in Unix
  SECONDS; the cutoff is seconds. A ms `now` would make the floor ≈
  always-true. The existing tests seed `updated_at: 1`, which now falls
  outside the window — they MUST be migrated to real-epoch values near a
  pinned `now`.

### Test notes

- Rewrite the BOUNDED test (test/autopilot-worker.test.ts:3024-3050):
  instead of seeding 40 done epics `updated_at:i` and asserting exactly 32
  carried, seed real-epoch `updated_at` (some inside `now - window`, some
  older) against a pinned `now` and assert in-window carried / stale
  dropped.
- Migrate every other done-epic reconcile test
  (test/autopilot-worker.test.ts ~2924, 2969, 2988, 3004) to seed
  `updated_at` near the pinned `now` (the `seedEpicRow` helper at :2869
  defaults to 1).
- Add boundary cases mirroring the recencyBound template
  (test/server-worker.test.ts:3326-3400, `NOW_SEC` anchor): `now-window-1`
  (include), `now-window` (boundary, `>=`), older (exclude).
- Add `getCollection("epics_recent_done")` registration assertion
  (test/collections.test.ts:140) and the descriptor-shape/`defaultClause`
  `toEqual` (test/collections.test.ts:397-430,836-842).
- Update the `DONE_EPICS_REAP_LIMIT` import
  (test/autopilot-worker.test.ts:47) to the new name/location.
- `bun run test:full` is the gate (touches daemon/worker/db read paths;
  the fast tier skips the integration files).

## Acceptance

- [ ] `EPICS_RECENT_DONE_DESCRIPTOR` exists in `src/collections.ts`, registered in `REGISTRY`, mirroring `EPICS_DESCRIPTOR`'s `columns`/`pk`/`version`/`sortable`/`jsonColumns`, scoped to `status='done'`, with `recencyBound` on `updated_at` = `DONE_EPICS_REAP_WINDOW_SEC` (1800).
- [ ] `loadReconcileSnapshot` sources done epics via `read("epics_recent_done")`; the dedup-by-`epic_id` merge and `orderEpicsForScheduling` are unchanged; no manual `doneFrame`/`limit` remains.
- [ ] `DONE_EPICS_REAP_LIMIT` is gone; `DONE_EPICS_REAP_WINDOW_SEC` lives in `src/collections.ts`; no count-`LIMIT` bounds the done read.
- [ ] Done-epic reconcile tests migrated to real-epoch `updated_at`; boundary tests (in/at/out of window) added and green.
- [ ] `recencyBound` example lists in `CLAUDE.md` + `README.md` include `epics_recent_done`; the README `loadReconcileSnapshot` sentence describes the time window.
- [ ] `bun run test:full` passes.

## Done summary
Replaced the count LIMIT 32 done-epics window in loadReconcileSnapshot with the time-bounded epics_recent_done collection (recencyBound updated_at >= now - 1800s, mirroring EPICS_DESCRIPTOR's full row shape). Migrated done-epic reconcile tests to real-epoch updated_at, added in/at/out-of-window boundary tests; full suite green.
## Evidence
