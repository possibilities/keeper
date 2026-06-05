## Overview

`scanZellijEventsDir` (src/daemon.ts) currently mints one
`BackendExecSnapshot` synthetic event for EVERY parsed zellij feed line
that joins to a live job — with no dedup against the job's current tab
state. Because `foldBackendExecSnapshot` is idempotent, the bulk of these
fold to no-ops, yet each still pays the full realtime-pipeline cost:
writer-lock INSERT → `data_version` bump → wake-worker → main drain → fold
→ kick server-worker → `diffTick` across ~30 subscribers → kick tab-namer
→ renameTab. Diagnosis on the live DB: `BackendExecSnapshot` is 498,490 of
731,050 events (68% of the entire log); 53.6% (266,994) are exact
consecutive duplicates that change nothing. During autopilot bursts this hit
~66 mints/sec and pegged the daemon ~1 core for 130 CPU-min over 133
wall-min — the congestion that makes the board/jobs/tabs feel non-realtime
(genuine events queue behind the churn).

The fix is a consumer-side dedup at the mint seam: skip the INSERT when a
line's effective `(tab_id, tab_name)` already equals the job's current
projection state. Server-only, schema-neutral (the `jobs.backend_exec_tab_*`
columns already exist, fn-668/v48), no SCHEMA_VERSION bump, no keeper-py
change. End state: pure consecutive repeats become zero-cost `continue`s;
real tab transitions and flaps still mint.

## Quick commands

- `bun test test/zellij-events-worker.test.ts` — the dedup + must-not-regress suite
- `bun run typecheck` (or the repo's `tsc --noEmit` equivalent) — confirms the `liveJobs` type-annotation change compiles
- After deploy, on the live DB: `sqlite3 ~/.local/state/keeper/keeper.db "WITH be AS (SELECT data, LAG(data) OVER (PARTITION BY session_id ORDER BY id) prev FROM events WHERE hook_event='BackendExecSnapshot' AND ts > strftime('%s','now')-3600) SELECT count(*) total, sum(data=prev) dupes FROM be;"` — the consecutive-dupe share should collapse toward 0 for events minted post-deploy

## Acceptance

- [ ] A re-scan of unchanged feed lines mints zero new `BackendExecSnapshot` events (in-scan dedup)
- [ ] A projection-seeded job whose current `(tab_id, tab_name)` equals an incoming line does NOT mint (cross-scan dedup)
- [ ] Real transitions still mint: an A→B→A tab_name flap within one scan mints exactly 3 events; a tab_id change with identical tab_name still mints
- [ ] The COALESCE asymmetry is honored: a line with `tab_id=null` but a changed `tab_name` still mints (never false-suppressed)
- [ ] Existing must-not-regress mint-count tests (lines ~120/197/259/440/727) still pass
- [ ] Doc/JSDoc prose updated in the SAME commit (README zellij prose + trace guidance, scanZellijEventsDir JSDoc, readLiveJobsWithCoords JSDoc + LiveJobRow, zellij-events.ts module JSDoc)
- [ ] No SCHEMA_VERSION bump, no keeper/api.py change (verify schema-neutral)

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). The
load-bearing proof is the test asserting an A→B→A flap mints 3 while a
pure-duplicate re-scan mints 0. If the dedup predicate is wrong (e.g.
name-only or raw-tab_id compare), the flap/COALESCE tests fail loudly before
anything ships. If it fails: fall back to comparing only the effective
persisted tuple exactly as the fold writes it (effectiveTabId = record.tab_id
?? lastKnown.tabId), which is the spec'd predicate.

## References

- Diagnosis (this conversation): 68% BackendExecSnapshot, 53.6% consecutive dupes, ~66/sec autopilot-burst storm, 130 CPU-min/133 wall-min peg.
- reducer.ts:3795-3813 `foldBackendExecSnapshot` — the COALESCE(tab_id) / hard-assign(tab_name) asymmetry the dedup compare must mirror.
- Prior zellij churn epics (all done): fn-684 (bridge), fn-704.1 (plugin diff-gate), fn-706 (rotation). Those attacked feed SIZE at the untrusted plugin (its diff gate resets every reload/rotation → full re-snapshot storm); this adds the missing dedup in keeperd itself (server = source of truth).
- epic-scout: no open epics; no deps/overlaps to wire.

## Best practices

- **Compare the full effective `(tab_id, tab_name)` tuple, never tab_name alone:** the fold COALESCE-preserves tab_id but hard-assigns tab_name, so a name change riding a null tab_id must still mint. [reducer.ts:3804-3812]
- **Normalize tab_id with `String(record.tab_id ?? "")`:** dodge the `3 !== "3"` JSON-number vs SQLite-TEXT mismatch that would defeat (or phantom-trigger) dedup. [parseZellijEventLine already String-coerces the feed side]
- **Skip-not-throw + update last-known only after a successful INSERT:** plain Map get/set is non-throwing; updating the in-scan map inside the `try` after `insertEvent.run()` (co-located with the TRACE_ZELLIJ tick) keeps a failed INSERT from marking a never-folded tuple as "sent".
- **Per-scan-rebuild over a persistent cache:** seeding last-known from the projection each scan needs no epoch-flush and no boot-seed (a plugin reload re-emits a manifest the projection already holds → correctly skipped). A persistent boot-seeded cache is the clean follow-up only if TRACE_ZELLIJ telemetry later shows fold-lag under-dedup is material.

## Snippet context

No snippets/bundles attached: searched promptctl ("event sourcing idempotent dedup sqlite", zero hits); the change is fully keeper-internal daemon/event-sourcing mechanics and the task spec carries all file:line context inline.
